import { describe, expect, it } from 'vitest';
import { nextPlanState, linearStateToStatus, type PlanStateLite } from '../src/types/roz-v2.js';

// La máquina de estados del plan es el contrato que comparten dashboard, runner y watchdog. Lo que
// se prueba es lo que no puede romperse: riesgo 2 nunca lo implementa el agente, riesgo 0 no espera
// aprobación, y nada sale de un estado terminal.

const p = (status: PlanStateLite['status'], risk: PlanStateLite['risk'] = 1, phase: PlanStateLite['phase'] = 'planear'): PlanStateLite => ({
  status,
  risk,
  phase,
});

describe('nextPlanState', () => {
  it('tomar: en_cola → planeando o implementando según la fase', () => {
    expect(nextPlanState(p('en_cola'), 'tomar')?.status).toBe('planeando');
    expect(nextPlanState(p('en_cola', 1, 'implementar'), 'tomar')?.status).toBe('implementando');
    expect(nextPlanState(p('planeando'), 'tomar')).toBeNull();
  });

  it('riesgo 2 nunca se implementa por el agente', () => {
    expect(nextPlanState(p('en_cola', 2, 'implementar'), 'tomar')).toBeNull();
    expect(nextPlanState(p('esperando_aprobacion', 2), 'aprobar')).toBeNull();
    expect(nextPlanState(p('planeando', 2), 'plan_listo')?.status).toBe('esperando_aprobacion');
  });

  it('riesgo 0 pasa de planear a implementar sin soltar el runner', () => {
    expect(nextPlanState(p('planeando', 0), 'plan_listo')).toEqual({ status: 'implementando', phase: 'implementar', releasesRunner: false });
  });

  it('riesgo 1: aprobar reencola para implementar; pedir cambios reencola para planear', () => {
    expect(nextPlanState(p('esperando_aprobacion', 1), 'aprobar')).toEqual({ status: 'en_cola', phase: 'implementar', releasesRunner: false });
    expect(nextPlanState(p('esperando_aprobacion', 1), 'pedir_cambios')?.phase).toBe('planear');
  });

  it('watchdog/fallo solo aplican a lo que corre, y conservan la fase', () => {
    expect(nextPlanState(p('implementando', 0, 'implementar'), 'watchdog')).toEqual({ status: 'en_cola', phase: 'implementar', releasesRunner: true });
    expect(nextPlanState(p('en_cola'), 'watchdog')).toBeNull();
  });

  it('reclamar y jalar no aplican mientras corre en la PC de alguien', () => {
    expect(nextPlanState(p('planeando'), 'reclamar')).toBeNull();
    expect(nextPlanState(p('implementando'), 'jalar')).toBeNull();
    expect(nextPlanState(p('en_cola'), 'jalar')?.status).toBe('jalado');
    expect(nextPlanState(p('jalado'), 'soltar')?.status).toBe('en_cola');
  });

  it('nada sale de hecho ni de cancelado', () => {
    for (const t of ['tomar', 'aprobar', 'reclamar', 'jalar', 'soltar', 'cancelar', 'issue_cerrado'] as const) {
      expect(nextPlanState(p('hecho'), t)).toBeNull();
      expect(nextPlanState(p('cancelado'), t)).toBeNull();
    }
  });
});

describe('linearStateToStatus', () => {
  it('started se parte en revisión por nombre', () => {
    expect(linearStateToStatus('started', 'In Progress')).toBe('en_progreso');
    expect(linearStateToStatus('started', 'In Review')).toBe('revision');
    expect(linearStateToStatus('triage', 'Triage')).toBe('pendiente');
    expect(linearStateToStatus('canceled', null)).toBe('cancelada');
  });
});
