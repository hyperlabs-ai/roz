// Aritmética de fechas para el calendario nativo de tareas. Sin librerías: solo Date + hora local.
// Todo trabaja en hora local del navegador; al mandar al backend se serializa con toIso (UTC con offset Z).

export const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" en hora local (para <input type="date"> y agrupar por día). */
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "HH:mm" en hora local (para <input type="time">). */
export function localTimeStr(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Combina "YYYY-MM-DD" + "HH:mm" (hora local) → ISO UTC (Z es un offset válido). */
export function toIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0).toISOString();
}

/** Lunes 00:00 (local) de la semana que contiene `d`. */
export function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (r.getDay() + 6) % 7; // 0 = lunes … 6 = domingo
  r.setDate(r.getDate() - day);
  return r;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Los 42 días (6 semanas × 7) que dibujan el mes, empezando en el lunes anterior al día 1. */
export function monthGrid(anchor: Date): Date[] {
  const first = startOfMonth(anchor);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** "Semana del 14 – 20 jul" o "14 jul – 3 ago" cuando cruza de mes. */
export function weekLabel(monday: Date): string {
  const sunday = addDays(monday, 6);
  const m = MONTHS_LONG[monday.getMonth()].slice(0, 3);
  const s = MONTHS_LONG[sunday.getMonth()].slice(0, 3);
  return monday.getMonth() === sunday.getMonth()
    ? `${monday.getDate()} – ${sunday.getDate()} ${s}`
    : `${monday.getDate()} ${m} – ${sunday.getDate()} ${s}`;
}

/** "julio 2026" */
export function monthLabel(d: Date): string {
  return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
