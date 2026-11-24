// Avisos de variables: los cambios seguidos del mismo entorno se juntan en un solo aviso.
import { describe, expect, it } from 'vitest';
import { mergeEnvNames, parseEnvNotice } from '../src/zeus/inbox.js';

const empty = { added: [], changed: [], deleted: [] };

describe('parseEnvNotice', () => {
  it('lee los nombres de cada grupo y si se rotó la llave', () => {
    const body = 'Nuevas: A, B\nCambiaron: C\n\nPonte al día: zeus env pull HYP api-production';
    expect(parseEnvNotice(body)).toEqual({ added: ['A', 'B'], changed: ['C'], deleted: [], rotated: false });
    expect(parseEnvNotice('Se rotó la llave del entorno. Los valores no cambiaron.').rotated).toBe(true);
  });
});

describe('mergeEnvNames', () => {
  it('suma variables subidas una por una', () => {
    const one = mergeEnvNames(empty, { ...empty, changed: ['A'] });
    const two = mergeEnvNames(one, { ...empty, changed: ['B'] });
    expect(two).toEqual({ added: [], changed: ['A', 'B'], deleted: [] });
  });

  it('una nueva que luego cambia sigue siendo nueva', () => {
    expect(mergeEnvNames({ ...empty, added: ['A'] }, { ...empty, changed: ['A'] })).toEqual({ added: ['A'], changed: [], deleted: [] });
  });

  it('una nueva que luego se quita desaparece', () => {
    expect(mergeEnvNames({ ...empty, added: ['A'] }, { ...empty, deleted: ['A'] })).toEqual(empty);
  });

  it('una que cambió y luego se quitó queda como quitada', () => {
    expect(mergeEnvNames({ ...empty, changed: ['A'] }, { ...empty, deleted: ['A'] })).toEqual({ added: [], changed: [], deleted: ['A'] });
  });

  it('una quitada que vuelve a subirse cuenta como cambio', () => {
    expect(mergeEnvNames({ ...empty, deleted: ['A'] }, { ...empty, added: ['A'] })).toEqual({ added: [], changed: ['A'], deleted: [] });
  });
});
