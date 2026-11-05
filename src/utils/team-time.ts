// "Hoy" en la zona del equipo. El servidor corre en UTC, así que sin esto "hoy" se adelanta 6 h
// respecto a quien usa la app: entre las 18:00 y la medianoche de México, UTC ya está en el día
// siguiente. Lo usan el dashboard (vencimientos) y la asignación automática (días hábiles).
export const TEAM_TZ = 'America/Mexico_City';

/** Hoy como YYYY-MM-DD en la zona del equipo. `en-CA` da justo ese formato. */
export function todayLocal(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TEAM_TZ });
}
