import { describe, expect, it } from 'vitest';
import {
  clientKeyFor,
  derivePersonState,
  localDayHour,
  pickAgentPlan,
  resolveWeekStart,
  weekStartFor,
  zonedMidnight,
} from '../src/dashboard/pulse.js';

// El Pulso es la pantalla principal: lo que se fija aquí es lo que, si se tuerce, miente en silencio
// (una semana que arranca en domingo, una persona "activa" que lleva horas sin tocar nada, un cliente
// partido en dos grupos).

describe('semana en la zona del equipo', () => {
  it('el lunes de la semana se calcula en CDMX, no en UTC', () => {
    // Domingo 8 nov 2026 a las 20:00 en CDMX = lunes 9 nov 02:00 UTC: sigue siendo la semana del 2.
    expect(weekStartFor(new Date('2026-11-09T02:00:00Z'))).toBe('2026-11-02');
    // Miércoles 11 nov.
    expect(weekStartFor(new Date('2026-11-11T18:00:00Z'))).toBe('2026-11-09');
  });

  it('weekStart inválido cae al lunes actual; uno válido se lleva a su lunes', () => {
    const now = new Date('2026-11-11T18:00:00Z');
    expect(resolveWeekStart(null, now)).toBe('2026-11-09');
    expect(resolveWeekStart('basura', now)).toBe('2026-11-09');
    expect(resolveWeekStart('2026-02-30', now)).toBe('2026-11-09');
    expect(resolveWeekStart('2026-11-05', now)).toBe('2026-11-02');
  });

  it('medianoche local y día/hora local', () => {
    expect(zonedMidnight('2026-11-09').toISOString()).toBe('2026-11-09T06:00:00.000Z');
    expect(localDayHour('2026-11-09T05:30:00Z')).toEqual({ day: '2026-11-08', hour: 23 });
    expect(localDayHour('2026-11-09T15:10:00Z')).toEqual({ day: '2026-11-09', hour: 9 });
  });
});

describe('estado de la persona', () => {
  const now = new Date('2026-11-11T18:00:00Z'); // 12:00 en CDMX

  it('ocupado gana si el calendario la marca busy (y no está viejo)', () => {
    const r = derivePersonState({
      now,
      lastActivityAt: '2026-11-11T17:55:00Z',
      presence: { status: 'busy', title: 'Daily', busyUntil: '2026-11-11T18:30:00Z', stale: false },
    });
    expect(r.state).toBe('ocupado');
    expect(r.stateDetail).toBe('En «Daily» hasta las 12:30');
  });

  it('un calendario viejo no sostiene "ocupado"', () => {
    const r = derivePersonState({
      now,
      lastActivityAt: null,
      presence: { status: 'busy', title: 'Daily', busyUntil: null, stale: true },
    });
    expect(r.state).toBe('fuera');
  });

  it('activo en 30 min, inactivo si hubo algo hoy, fuera si no', () => {
    expect(derivePersonState({ now, lastActivityAt: '2026-11-11T17:40:00Z', presence: null }).state).toBe('activo');
    expect(derivePersonState({ now, lastActivityAt: '2026-11-11T15:00:00Z', presence: null }).state).toBe('inactivo');
    // 23:00 de ayer en CDMX (05:00 UTC de hoy) no es "hoy".
    expect(derivePersonState({ now, lastActivityAt: '2026-11-11T05:00:00Z', presence: null }).state).toBe('fuera');
    expect(derivePersonState({ now, lastActivityAt: null, presence: null }).state).toBe('fuera');
  });
});

describe('plan de la tarjeta y grupos', () => {
  it('prefiere lo que corre, luego lo que espera aprobación; nunca un terminal', () => {
    const plans = [
      { id: 'a', status: 'en_cola' as const, updated_at: '2026-11-11T10:00:00Z' },
      { id: 'b', status: 'esperando_aprobacion' as const, updated_at: '2026-11-10T10:00:00Z' },
      { id: 'c', status: 'hecho' as const, updated_at: '2026-11-11T11:00:00Z' },
    ];
    expect(pickAgentPlan(plans)?.id).toBe('b');
    expect(pickAgentPlan([...plans, { id: 'd', status: 'implementando' as const, updated_at: '2026-11-01T00:00:00Z' }])?.id).toBe('d');
    expect(pickAgentPlan([plans[2]!])).toBeNull();
  });

  it('cliente: dominio, luego el proyecto cliente, luego interno', () => {
    expect(clientKeyFor({ id: 'p1', name: 'Acme', kind: 'client', client_email_domains: ['Acme.com'] }).key).toBe('acme.com');
    expect(clientKeyFor({ id: 'p1', name: 'Acme', kind: 'client', client_email_domains: [] })).toEqual({ key: 'p1', label: 'Acme' });
    expect(clientKeyFor({ id: 'p2', name: 'roz', kind: 'internal' })).toEqual({ key: 'interno', label: 'Interno' });
  });
});
