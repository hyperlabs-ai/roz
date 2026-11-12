import { describe, expect, it } from 'vitest';
import { generateRunnerToken, hashRunnerToken, looksLikeRunnerToken, runnerTokenPrefix } from '../src/plans/tokens.js';
import { buildRunnerPrompt, MAX_TURNS, type PromptInput } from '../src/plans/prompt.js';

// Token del runner y prompt del agente. El token: formato fijo (el auth descarta basura sin ir a la
// base) y hash estable. El prompt: el planId/leaseId que el agente necesita para report_progress, y
// que la fase de planear NO autorice a tocar código.

describe('token del runner', () => {
  it('rozr_ + 32 bytes base64url, prefijo de 12, hash sha256 hex', () => {
    const t = generateRunnerToken();
    expect(t).toMatch(/^rozr_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeRunnerToken(t)).toBe(true);
    expect(runnerTokenPrefix(t)).toBe(t.slice(0, 12));
    expect(hashRunnerToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRunnerToken(t)).toBe(hashRunnerToken(t));
    expect(generateRunnerToken()).not.toBe(t);
  });

  it('rechaza tokens con otra forma', () => {
    for (const bad of ['', 'Bearer x', 'rozr_corto', `xxxx_${'a'.repeat(43)}`, `rozr_${'a'.repeat(42)}!`]) {
      expect(looksLikeRunnerToken(bad), bad).toBe(false);
    }
  });
});

const base: PromptInput = {
  planId: '11111111-1111-1111-1111-111111111111',
  leaseId: '22222222-2222-2222-2222-222222222222',
  phase: 'planear',
  risk: 1,
  riskReasons: [{ code: 'cliente_sla', detail: 'cliente con SLA' }],
  identifier: 'HYP-7',
  title: 'Exportar reportes',
  description: 'El cliente quiere CSV',
  url: 'https://linear.app/hyp/issue/HYP-7',
  projectName: 'Portal',
  repo: 'org/portal',
  branch: 'hyp-7-exportar-reportes',
  planMd: null,
  feedback: null,
};

describe('buildRunnerPrompt', () => {
  it('planear: solo PLAN.md, con riesgo, issue y lease para report_progress', () => {
    const p = buildRunnerPrompt(base);
    expect(p).toContain('HYP-7');
    expect(p).toContain('El cliente quiere CSV');
    expect(p).toContain('cliente con SLA');
    expect(p).toMatch(/NO modifiques ningún archivo salvo PLAN\.md/);
    expect(p).toContain(base.planId);
    expect(p).toContain(base.leaseId);
    expect(p).not.toContain('PLAN.md aprobado');
  });

  it('planear tras pedir cambios: incluye borrador y comentarios', () => {
    const p = buildRunnerPrompt({ ...base, planMd: '# borrador viejo', feedback: 'Falta manejar archivos grandes' });
    expect(p).toContain('# borrador viejo');
    expect(p).toContain('Falta manejar archivos grandes');
  });

  it('implementar: plan aprobado, rama, y sin push (lo hace el runner)', () => {
    const p = buildRunnerPrompt({ ...base, phase: 'implementar', risk: 0, planMd: '# plan aprobado' });
    expect(p).toContain('PLAN.md aprobado');
    expect(p).toContain('# plan aprobado');
    expect(p).toContain('hyp-7-exportar-reportes');
    expect(p).toMatch(/NO hagas push/);
  });

  it('turnos por fase', () => {
    expect(MAX_TURNS).toEqual({ planear: 40, implementar: 120 });
  });
});
