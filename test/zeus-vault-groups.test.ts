// La pestaña Variables agrupa los entornos por repo: `<repo>-<etapa>` es UN repo con variantes Local
// y Prod (web/src/components/zeus/vault-groups.ts, módulo puro).
import { describe, expect, it } from 'vitest';
import { auditEnvParts, envParts, groupVaultEnvs } from '../web/src/components/zeus/vault-groups.js';

const env = (name: string, project = 'HUB') => ({ id: `${project}/${name}`, projectId: `p-${project}`, projectKey: project, projectName: project === 'HUB' ? 'HyperHub' : 'Orwel', name });

describe('envParts', () => {
  it('separa repo y etapa del estándar del CLI', () => {
    expect(envParts('api-hyperhub-production')).toEqual({ repo: 'api-hyperhub', stage: 'production' });
    expect(envParts('claude-development')).toEqual({ repo: 'claude', stage: 'development' });
    expect(envParts('production')).toEqual({ repo: null, stage: 'production' });
    expect(envParts('sandbox')).toEqual({ repo: null, stage: null });
    // "productions" no es la etapa production.
    expect(envParts('api-productions')).toEqual({ repo: null, stage: null });
  });
});

describe('groupVaultEnvs', () => {
  it('una fila por repo con sus variantes, local antes que prod', () => {
    const g = groupVaultEnvs([
      env('site-hyperhub-production'),
      env('api-hyperhub-production'),
      env('api-hyperhub-development'),
      env('claude-development', 'ORWEL'),
    ]);
    expect(g.map((p) => p.name)).toEqual(['HyperHub', 'Orwel']);
    const hub = g[0]!;
    expect(hub.repos.map((r) => r.repo)).toEqual(['api-hyperhub', 'site-hyperhub']);
    expect(hub.repos[0]!.variants.map((v) => [v.stage, v.env.name])).toEqual([
      ['development', 'api-hyperhub-development'],
      ['production', 'api-hyperhub-production'],
    ]);
    expect(hub.repos[1]!.variants.map((v) => v.stage)).toEqual(['production']);
    expect(g[1]!.repos).toEqual([expect.objectContaining({ repo: 'claude', variants: [expect.objectContaining({ stage: 'development' })] })]);
  });

  it('un nombre fuera del patrón queda como repo sin etapa, sin mezclarse; solo la etapa cuelga de la clave del proyecto', () => {
    const g = groupVaultEnvs([env('sandbox'), env('production'), env('development'), env('hub')]);
    const repos = g[0]!.repos;
    expect(repos.map((r) => [r.repo, r.variants.map((v) => v.stage)])).toEqual([
      ['hub', ['development', 'production']],
      ['hub', [null]],
      ['sandbox', [null]],
    ]);
    expect(new Set(repos.map((r) => r.id)).size).toBe(3);
  });

  it('repos de distintos proyectos con el mismo nombre no se juntan', () => {
    const g = groupVaultEnvs([env('api-production', 'HUB'), env('api-production', 'ORWEL')]);
    expect(g.map((p) => p.repos.length)).toEqual([1, 1]);
  });
});

describe('auditEnvParts', () => {
  it('lee la etiqueta de la auditoría como repo + etapa', () => {
    expect(auditEnvParts('HUB · api-hyperhub-production')).toEqual({ project: 'HUB', repo: 'api-hyperhub', stage: 'production' });
    expect(auditEnvParts('HUB · development')).toEqual({ project: 'HUB', repo: 'hub', stage: 'development' });
    expect(auditEnvParts('HUB · sandbox')).toEqual({ project: 'HUB', repo: 'sandbox', stage: null });
  });
});
