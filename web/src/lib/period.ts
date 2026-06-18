// Modelo de períodos y comparación para el dashboard. Las funciones de rango son
// DETERMINISTAS a nivel de día (el fin de un período abierto es el inicio de "mañana"), así
// no cambian en cada render → evita bucles de fetch. La comparación se calcula como un rango
// explícito que el front manda al backend.

export interface Range {
  from: string; // ISO
  to: string; // ISO (exclusivo)
}

export type PresetId = 'this_month' | 'last_month' | 'last_30' | 'last_90' | 'this_quarter' | 'this_year' | 'custom';
export type CompareId = 'previous' | 'year_ago' | 'none';

export interface PeriodState {
  preset: PresetId;
  range: Range; // rango efectivo (para custom lo fija el calendario)
  compare: CompareId;
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfTomorrow = (now: Date) => addDays(startOfDay(now), 1);

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'this_month', label: 'Este mes' },
  { id: 'last_month', label: 'Mes pasado' },
  { id: 'last_30', label: 'Últimos 30 días' },
  { id: 'last_90', label: 'Últimos 90 días' },
  { id: 'this_quarter', label: 'Este trimestre' },
  { id: 'this_year', label: 'Este año' },
];

export const COMPARES: { id: CompareId; label: string }[] = [
  { id: 'previous', label: 'vs. período anterior' },
  { id: 'year_ago', label: 'vs. año pasado' },
  { id: 'none', label: 'Sin comparación' },
];

export function presetRange(preset: Exclude<PresetId, 'custom'>): Range {
  const now = new Date();
  const to = startOfTomorrow(now);
  let from: Date;
  switch (preset) {
    case 'this_month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_month':
      return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    case 'last_30':
      from = addDays(startOfDay(now), -29);
      break;
    case 'last_90':
      from = addDays(startOfDay(now), -89);
      break;
    case 'this_quarter':
      from = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      break;
    case 'this_year':
      from = new Date(now.getFullYear(), 0, 1);
      break;
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Rango de comparación según el modo. null = sin comparación. */
export function comparisonRange(range: Range, compare: CompareId): Range | null {
  if (compare === 'none') return null;
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (compare === 'previous') {
    const span = to.getTime() - from.getTime();
    return { from: new Date(from.getTime() - span).toISOString(), to: range.from };
  }
  // year_ago: mismo rango desplazado un año atrás.
  const shift = (d: Date) => new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()).toISOString();
  return { from: shift(from), to: shift(to) };
}

/** Rango personalizado a partir de un par de fechas del calendario (to inclusivo). */
export function customRange(from: Date, to: Date): Range {
  return { from: startOfDay(from).toISOString(), to: addDays(startOfDay(to), 1).toISOString() };
}

export function defaultPeriod(): PeriodState {
  return { preset: 'this_month', range: presetRange('this_month'), compare: 'previous' };
}

/** Etiqueta legible del rango efectivo. */
export function rangeLabel(state: PeriodState): string {
  if (state.preset !== 'custom') return PRESETS.find((p) => p.id === state.preset)?.label ?? 'Período';
  const f = new Date(state.range.from);
  const t = addDays(new Date(state.range.to), -1); // volver a inclusivo para mostrar
  const sameYear = f.getFullYear() === t.getFullYear();
  const fmt = (d: Date, withYear: boolean) => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${withYear ? ` ${d.getFullYear()}` : ''}`;
  return `${fmt(f, !sameYear)} – ${fmt(t, true)}`;
}

export function compareLabel(compare: CompareId): string {
  return COMPARES.find((c) => c.id === compare)?.label ?? '';
}
