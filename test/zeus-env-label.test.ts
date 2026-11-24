// Cómo se nombra un entorno frente a una persona: "api-hyperhub (Prod)", no api-hyperhub-production.
// Back (src/zeus/env-label.ts) y front (web/src/components/zeus/vault-groups.ts) deben coincidir.
import { describe, expect, it } from 'vitest';
import { envDisplay, prettyEnvText as backPretty } from '../src/zeus/env-label.js';
import { prettyEnvText as frontPretty } from '../web/src/components/zeus/vault-groups.js';

describe('nombre de entorno para personas', () => {
  it('repo + etapa; sin repo usa el proyecto; fuera del estándar queda igual', () => {
    expect(envDisplay('api-hyperhub-production')).toBe('api-hyperhub (Prod)');
    expect(envDisplay('claude-development')).toBe('claude (Local)');
    expect(envDisplay('development', 'ORWEL')).toBe('ORWEL (Local)');
    expect(envDisplay('staging-eu')).toBe('staging-eu');
  });

  it.each([
    ['Alan cambió 1 variable de HYPERHUB/api-hyperhub-production', 'Alan cambió 1 variable de api-hyperhub (Prod)'],
    ['Ya tienes acceso a ORWEL/development', 'Ya tienes acceso a ORWEL (Local)'],
    ['consultó api-hyperhub-production y claude-development', 'consultó api-hyperhub (Prod) y claude (Local)'],
    // Los comandos se quedan con el nombre real: son para copiar y correr.
    ['Ponte al día: zeus env pull HYPERHUB api-hyperhub-development   (o `zeus env status`)', 'Ponte al día: zeus env pull HYPERHUB api-hyperhub-development   (o `zeus env status`)'],
    ['zeus env pull ORWEL development', 'zeus env pull ORWEL development'],
  ])('%s', (input, expected) => {
    expect(backPretty(input)).toBe(expected);
    expect(frontPretty(input)).toBe(expected);
  });
});
