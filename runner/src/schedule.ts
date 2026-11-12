// Horario del runner: parseo de las banderas de la CLI (--horario 9-19, --dias 1-5) y cálculo de
// "¿estoy en horario?" en la zona del equipo. El servidor es quien decide (next-job responde
// retryAfterMs fuera de horario); esto sirve para validar lo que escribe la persona y para `status`.
import { DEFAULT_RUNNER_SCHEDULE, type RunnerSchedule } from './types.js';

export class ScheduleError extends Error {}

/** "9" → 540, "9:30" → 570, "19:00" → 1140, "24" → 1440. Error si no es una hora válida. */
export function parseClock(raw: string): number {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) throw new ScheduleError(`hora inválida: "${raw}" (usa 9, 9:30 o 19:00)`);
  const h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  if (min > 59) throw new ScheduleError(`minutos inválidos en "${raw}"`);
  if (h > 24 || (h === 24 && min > 0)) throw new ScheduleError(`hora fuera de rango en "${raw}"`);
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "9-19" | "9:30-18:15" → { start: '09:00', end: '19:00' }. No acepta horarios que crucen la medianoche. */
export function parseHorario(raw: string): { start: string; end: string } {
  const parts = raw.split('-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ScheduleError(`horario inválido: "${raw}" (usa inicio-fin, p. ej. 9-19 o 9:30-18:00)`);
  }
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (end <= start) throw new ScheduleError(`el horario "${raw}" debe terminar después de empezar`);
  return { start: formatClock(start), end: formatClock(end) };
}

/** "1-5" | "1,3,5" | "1-3,6" → [1,2,3,6] (1 = lunes … 7 = domingo). */
export function parseDias(raw: string): number[] {
  const out = new Set<number>();
  for (const chunk of raw.split(',')) {
    const piece = chunk.trim();
    if (!piece) continue;
    const range = /^(\d)\s*-\s*(\d)$/.exec(piece);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b > 7 || a > b) throw new ScheduleError(`rango de días inválido: "${piece}" (1 = lunes … 7 = domingo)`);
      for (let d = a; d <= b; d++) out.add(d);
      continue;
    }
    if (!/^\d$/.test(piece)) throw new ScheduleError(`día inválido: "${piece}" (1 = lunes … 7 = domingo)`);
    const d = Number(piece);
    if (d < 1 || d > 7) throw new ScheduleError(`día fuera de rango: "${piece}" (1 = lunes … 7 = domingo)`);
    out.add(d);
  }
  if (out.size === 0) throw new ScheduleError('no hay días en el horario');
  return [...out].sort((a, b) => a - b);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Arma el horario desde las banderas; lo que no venga se toma de `base` (o del default del equipo). */
export function buildSchedule(
  flags: { horario?: string; dias?: string; tz?: string },
  base: RunnerSchedule = DEFAULT_RUNNER_SCHEDULE,
): RunnerSchedule {
  const tz = flags.tz ?? base.tz;
  if (!isValidTimeZone(tz)) throw new ScheduleError(`zona horaria inválida: "${tz}"`);
  const hours = flags.horario ? parseHorario(flags.horario) : { start: base.start, end: base.end };
  const days = flags.dias ? parseDias(flags.dias) : [...base.days];
  return { tz, days, start: hours.start, end: hours.end };
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, fmt);
  }
  return fmt;
}

/** Día ISO (1-7) y minuto del día de `date` en la zona `tz`. */
export function localParts(date: Date, tz: string): { day: number; minute: number } {
  const fmt = formatterFor(tz);
  let day = 1;
  let hour = 0;
  let minute = 0;
  for (const p of fmt.formatToParts(date)) {
    if (p.type === 'weekday') day = WEEKDAY[p.value] ?? 1;
    else if (p.type === 'hour') hour = Number(p.value) % 24;
    else if (p.type === 'minute') minute = Number(p.value);
  }
  return { day, minute: hour * 60 + minute };
}

export function inSchedule(schedule: RunnerSchedule, now: Date = new Date()): boolean {
  return inWindow(schedule, parseClock(schedule.start), parseClock(schedule.end), now);
}

function inWindow(schedule: RunnerSchedule, start: number, end: number, at: Date): boolean {
  const { day, minute } = localParts(at, schedule.tz);
  return schedule.days.includes(day) && minute >= start && minute < end;
}

/**
 * Milisegundos hasta el próximo inicio de horario (0 si ya está en horario). Avanza de minuto en
 * minuto (como mucho 8 días): simple y correcto con cambios de horario de verano.
 */
export function msUntilInSchedule(schedule: RunnerSchedule, now: Date = new Date()): number {
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  if (inWindow(schedule, start, end, now)) return 0;
  const MINUTE = 60_000;
  const first = Math.ceil(now.getTime() / MINUTE) * MINUTE;
  for (let t = first, i = 0; i < 8 * 24 * 60; t += MINUTE, i++) {
    if (inWindow(schedule, start, end, new Date(t))) return t - now.getTime();
  }
  return Number.POSITIVE_INFINITY; // horario sin días válidos
}

export function describeSchedule(s: RunnerSchedule): string {
  const names = ['', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
  return `${s.days.map((d) => names[d] ?? String(d)).join(' ')} ${s.start}-${s.end} (${s.tz})`;
}
