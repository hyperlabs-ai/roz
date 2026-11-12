import { describe, expect, it } from 'vitest';
import {
  ScheduleError,
  buildSchedule,
  inSchedule,
  msUntilInSchedule,
  parseClock,
  parseDias,
  parseHorario,
} from '../src/schedule.js';
import type { RunnerSchedule } from '../src/types.js';

describe('parseHorario', () => {
  it('acepta horas sueltas y con minutos', () => {
    expect(parseHorario('9-19')).toEqual({ start: '09:00', end: '19:00' });
    expect(parseHorario('9:30-18:15')).toEqual({ start: '09:30', end: '18:15' });
    expect(parseHorario(' 0 - 24 ')).toEqual({ start: '00:00', end: '24:00' });
  });

  it('rechaza formatos inválidos, rangos al revés y horas fuera de rango', () => {
    for (const bad of ['9', '9-', '-19', '9-19-20', 'a-b', '19-9', '9-9', '25-26', '9:60-10', '24:30-1']) {
      expect(() => parseHorario(bad), bad).toThrow(ScheduleError);
    }
  });

  it('parseClock', () => {
    expect(parseClock('7')).toBe(420);
    expect(parseClock('07:05')).toBe(425);
    expect(() => parseClock('7.5')).toThrow(ScheduleError);
  });
});

describe('parseDias', () => {
  it('rangos, listas y mezcla, sin duplicados y ordenado', () => {
    expect(parseDias('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDias('6,1,3')).toEqual([1, 3, 6]);
    expect(parseDias('1-3,2,7')).toEqual([1, 2, 3, 7]);
  });
  it('rechaza días fuera de 1-7 y vacíos', () => {
    for (const bad of ['0', '8', '5-1', '1-9', '', 'lun']) expect(() => parseDias(bad), bad).toThrow(ScheduleError);
  });
});

describe('buildSchedule', () => {
  it('toma lo que no venga del horario base', () => {
    const base: RunnerSchedule = { tz: 'America/Mexico_City', days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00' };
    expect(buildSchedule({ horario: '10-18' }, base)).toEqual({ ...base, start: '10:00', end: '18:00' });
    expect(buildSchedule({ dias: '6-7', tz: 'UTC' }, base)).toEqual({ ...base, tz: 'UTC', days: [6, 7] });
  });
  it('valida la zona horaria', () => {
    expect(() => buildSchedule({ tz: 'Marte/Olympus' })).toThrow(ScheduleError);
  });
});

describe('inSchedule / msUntilInSchedule', () => {
  const utc: RunnerSchedule = { tz: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00' };

  it('respeta día y hora en la zona del horario', () => {
    // 2026-11-11 es miércoles.
    expect(inSchedule(utc, new Date('2026-11-11T09:00:00Z'))).toBe(true);
    expect(inSchedule(utc, new Date('2026-11-11T18:59:00Z'))).toBe(true);
    expect(inSchedule(utc, new Date('2026-11-11T19:00:00Z'))).toBe(false);
    expect(inSchedule(utc, new Date('2026-11-11T08:59:00Z'))).toBe(false);
    // sábado
    expect(inSchedule(utc, new Date('2026-11-14T12:00:00Z'))).toBe(false);
  });

  it('usa la zona: 15:00 UTC son 09:00 en Ciudad de México', () => {
    const mx: RunnerSchedule = { ...utc, tz: 'America/Mexico_City' };
    expect(inSchedule(mx, new Date('2026-11-11T14:59:00Z'))).toBe(false);
    expect(inSchedule(mx, new Date('2026-11-11T15:00:00Z'))).toBe(true);
  });

  it('calcula cuánto falta para el inicio (0 si ya está en horario)', () => {
    expect(msUntilInSchedule(utc, new Date('2026-11-11T10:00:00Z'))).toBe(0);
    expect(msUntilInSchedule(utc, new Date('2026-11-11T08:00:00Z'))).toBe(60 * 60_000);
    // viernes 20:00 → lunes 09:00 = 61 h
    expect(msUntilInSchedule(utc, new Date('2026-11-13T20:00:00Z'))).toBe(61 * 60 * 60_000);
  });
});
