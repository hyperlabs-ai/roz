export function compact(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

export function hours(n: number): string {
  if (n <= 0) return '—';
  if (n >= 48) return `${Math.round(n / 24)}d`;
  return `${n}h`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parsea una fecha respetando el día que representa.
 *
 * `new Date('2026-07-31')` NO da el 31 en México: la especificación obliga a leer un string de solo
 * fecha como medianoche UTC, y con UTC−6 eso cae el 30 a las 18:00 — así que `getDate()` devuelve
 * 30. Las columnas `date` de Postgres (due_date) llegan justo en ese formato, y por eso una fecha
 * límite puesta el 31 se mostraba como "30 jul".
 *
 * Solo aplica al caso de fecha sin hora: se ancla al mediodía LOCAL, que ningún desplazamiento de
 * zona puede mover a otro día. Los timestamps completos (con hora y zona) se dejan intactos.
 */
export function parseDate(iso: string): Date {
  return new Date(DATE_ONLY.test(iso) ? `${iso}T12:00:00` : iso);
}

/** "2026-06-18T12:00:00Z" o "2026-06-18" -> "18 jun" */
export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = parseDate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * ¿Ese día ya pasó? Compara días como texto (YYYY-MM-DD ordena igual que la fecha), la misma regla
 * que usa el backend para `overdue` — si divergieran, la fila cambiaría de color al recargar.
 */
export function isPastDay(iso: string | null): boolean {
  if (!iso) return false;
  const today = new Date();
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return iso.slice(0, 10) < local;
}

/** Tiempo relativo en español, corto. */
export function relative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d`;
  return shortDate(iso);
}
