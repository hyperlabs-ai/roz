import { describe, it, expect } from 'vitest';
import { STALE_PENDING_MS, isOverride, shouldAutoAssign, summarizeAutoAssign, validateOverride } from '../src/assign/rules.js';
import { isOverrideRequired, needsOverride } from '../web/src/lib/assign.js';
import type { Ticket } from '../web/src/lib/api.js';

// Cuándo se dispara la asignación automática y qué cuenta como override. El override es lo que hace
// que el algoritmo mejore: si se pide de más, la gente lo esquiva; si se pide de menos, el log no
// enseña nada. Por eso su tabla está probada completa.

describe('cuándo se autoasigna una tarea nueva (POST /tickets)', () => {
  it('solo si se pide EXPLÍCITO: el diálogo normal ya no autoasigna (para eso está /ticket)', () => {
    expect(shouldAutoAssign({}, true)).toBe(false);
    expect(shouldAutoAssign({ autoAssign: true }, true)).toBe(true);
    expect(shouldAutoAssign({ autoAssign: true, status: 'pendiente', assigneeDevIds: [] }, true)).toBe(true);
  });

  it('un responsable explícito siempre gana', () => {
    expect(shouldAutoAssign({ autoAssign: true, assigneeDevId: 'd1' }, true)).toBe(false);
    expect(shouldAutoAssign({ autoAssign: true, assigneeDevIds: ['d1'] }, true)).toBe(false);
  });

  it('apagada explícitamente, una tarea cerrada o la función apagada → no', () => {
    expect(shouldAutoAssign({ autoAssign: false }, true)).toBe(false);
    expect(shouldAutoAssign({ autoAssign: true, status: 'completada' }, true)).toBe(false);
    expect(shouldAutoAssign({ autoAssign: true }, false)).toBe(false);
  });
});

describe('qué cuenta como override', () => {
  const asignada = { outcome: 'assigned' as const, chosenDevId: 'roz-eligio', overriddenAt: null };

  it('cambiar el responsable que eligió roz → sí (también dejarla sin nadie)', () => {
    expect(isOverride(asignada, 'roz-eligio', ['otra'])).toBe(true);
    expect(isOverride(asignada, 'roz-eligio', [])).toBe(true);
  });

  it('sumar gente de apoyo sin cambiar al principal → no', () => {
    expect(isOverride(asignada, 'roz-eligio', ['roz-eligio', 'apoyo'])).toBe(false);
  });

  it('solo la primera vez: una decisión ya corregida no vuelve a pedir motivo', () => {
    expect(isOverride({ ...asignada, overriddenAt: '2026-11-02T10:00:00Z' }, 'roz-eligio', ['otra'])).toBe(false);
  });

  it('sin elección de roz que corregir → no (escalada, fallida, pendiente, o ya la habían cambiado)', () => {
    expect(isOverride({ ...asignada, outcome: 'escalated', chosenDevId: null }, null, ['a'])).toBe(false);
    expect(isOverride({ ...asignada, outcome: 'failed', chosenDevId: null }, null, ['a'])).toBe(false);
    expect(isOverride(asignada, 'alguien-mas', ['otra'])).toBe(false);
    expect(isOverride(null, 'x', ['y'])).toBe(false);
    expect(isOverride(asignada, 'roz-eligio', undefined)).toBe(false);
  });
});

describe('motivo del override', () => {
  it('solo acepta categorías de la lista cerrada', () => {
    expect(validateOverride({ category: 'carga_real' })).toEqual({ category: 'carga_real', note: null });
    expect(() => validateOverride({ category: 'me_cae_mejor' })).toThrow(/inválida/);
  });

  it('"otro" exige nota', () => {
    expect(() => validateOverride({ category: 'otro', note: '  ' })).toThrow(/nota/);
    expect(validateOverride({ category: 'otro', note: 'se fue de vacaciones' }).note).toBe('se fue de vacaciones');
  });
});

describe('estado que ve la UI', () => {
  const row = {
    id: 'd',
    outcome: 'pending' as const,
    chosen_dev_id: null,
    overridden_at: null,
    suggestion: null,
    created_at: '2026-11-02T10:00:00Z',
    decided_at: null,
  };
  const t0 = Date.parse(row.created_at);

  it('una corrida pendiente de más de 2 h se muestra como fallida', () => {
    expect(summarizeAutoAssign(row, t0 + 60_000)!.state).toBe('pending');
    expect(summarizeAutoAssign(row, t0 + STALE_PENDING_MS + 1)!.state).toBe('failed');
  });

  it('una asignación corregida se muestra como override; una omitida no se muestra', () => {
    expect(summarizeAutoAssign({ ...row, outcome: 'assigned', overridden_at: '2026-11-02T11:00:00Z' })!.state).toBe('overridden');
    expect(summarizeAutoAssign({ ...row, outcome: 'skipped' })).toBeNull();
    // Una vista previa de ticket todavía no es una decisión sobre ninguna tarea.
    expect(summarizeAutoAssign({ ...row, outcome: 'preview' })).toBeNull();
  });
});

describe('la misma regla en el cliente (para no esperar al 409)', () => {
  const person = (id: string) => ({ id, name: id, avatarUrl: null });
  const task = (assignees: string[], autoAssign: Ticket['autoAssign']) =>
    ({ assignees: assignees.map(person), assignee: assignees[0] ? person(assignees[0]) : null, autoAssign }) as unknown as Ticket;
  const auto = { decisionId: 'd', state: 'assigned' as const, chosenDevId: 'roz-eligio', suggestion: null, decidedAt: null };

  it('coincide con el backend: pide motivo solo al cambiar al elegido por roz', () => {
    expect(needsOverride(task(['roz-eligio'], auto), ['otra'])).toBe(true);
    expect(needsOverride(task(['roz-eligio'], auto), ['roz-eligio', 'apoyo'])).toBe(false);
    expect(needsOverride(task(['roz-eligio'], { ...auto, state: 'overridden' }), ['otra'])).toBe(false);
    expect(needsOverride(task(['otra'], auto), ['tercera'])).toBe(false);
    expect(needsOverride(task([], null), ['a'])).toBe(false);
  });

  it('reconoce el 409 del backend por su código', () => {
    expect(isOverrideRequired({ code: 'OVERRIDE_REASON_REQUIRED', status: 409 })).toBe(true);
    expect(isOverrideRequired(new Error('otra cosa'))).toBe(false);
  });
});
