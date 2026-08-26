// Derivación del estado de presencia y su consulta para el dashboard.
//
// La pieza clave de todo el diseño vive aquí: el estado ocupado/libre NO se guarda en la base. Se
// deriva de `now()` contra los bloques cacheados, en cada lectura. Por eso el indicador cambia en el
// instante exacto en que una junta empieza o termina, aunque a Google solo se le pregunte cada 5
// minutos — lo único que puede tardar es un evento recién creado.
//
// `derivePresence` es pura a propósito: es la lógica con más casos límite de la feature y así se
// prueba sin base de datos ni relojes reales.
import { db } from '../db/supabase.js';

/** Sin noticias del sondeo por más de esto, el estado deja de ser afirmable. */
const STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * Cuánto futuro se mira para anunciar "próxima junta a las…" en el resumen.
 *
 * Corto a propósito: anunciar como "próxima" una junta a treinta horas de distancia es ruido.
 */
const LOOKAHEAD_MS = 12 * 60 * 60 * 1000;

/**
 * Horizonte del desglose horario del hover. Es OTRA cosa que el lookahead del resumen y por eso es
 * otra constante: aquí no se anuncia nada, se enseña la agenda, y recortarla a 12 h dejaba fuera la
 * tarde entera cuando alguien miraba de noche.
 */
const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PresenceStatus = 'busy' | 'free' | 'unknown';

export interface PresenceBlock {
  title: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}

/** Un bloque de la agenda tal como se muestra: lo mínimo para pintar un renglón de horario. */
export interface UpcomingBlock {
  title: string | null;
  startsAt: string;
  endsAt: string;
  /** En curso ahora mismo. El front lo resalta para separar "esto" de "lo que viene". */
  current: boolean;
}

export interface DevPresence {
  devId: string;
  status: PresenceStatus;
  /** Título del evento en curso (o del próximo, si está libre). */
  title: string | null;
  /** Fin de la racha de ocupación, colapsando juntas pegadas. */
  busyUntil: string | null;
  nextStartsAt: string | null;
  nextTitle: string | null;
  /**
   * Lo que queda del día: el bloque en curso más los siguientes, para el desglose al pasar el mouse.
   *
   * El resumen (`status` + `busyUntil`) colapsa juntas pegadas a propósito, así que por sí solo no
   * puede responder "¿a qué horas exactamente estoy ocupado?". Esta lista sí.
   */
  upcoming: UpcomingBlock[];
  /** El sondeo lleva demasiado sin correr: el estado se muestra apagado en vez de afirmarse. */
  stale: boolean;
}

/** Tope de renglones del desglose. Un día con más citas que esto no cabe en un tooltip legible. */
const MAX_UPCOMING = 10;

/**
 * Estado de un dev a partir de sus bloques.
 *
 * Reglas que importan:
 *  · Los eventos de todo el día NO ocupan. Un cumpleaños o unas vacaciones marcadas de 00:00 a 00:00
 *    dejarían a alguien "en junta" veinticuatro horas.
 *  · La hora es la del evento EN CURSO, no la de una racha. Antes se encadenaban los bloques
 *    pegados, lo que servía cuando el titular decía "Ocupado"; desde que nombra la actividad,
 *    "Toy Dormido hasta 14:00" es simplemente falso — se duerme hasta las 09:30.
 *  · De varios eventos solapados manda el que empezó MÁS TARDE: es lo último en lo que la persona
 *    entró, y por tanto lo que está haciendo.
 *  · Sin cuenta conectada el estado es `unknown`, no `free`. No es lo mismo "está libre" que "no
 *    tengo idea", y la UI no debe pintar nada en el segundo caso.
 */
export function derivePresence(
  devId: string,
  blocks: PresenceBlock[],
  opts: { now: Date; connected: boolean; lastSyncedAt: string | null },
): DevPresence {
  const base: DevPresence = {
    devId,
    status: 'unknown',
    title: null,
    busyUntil: null,
    nextStartsAt: null,
    nextTitle: null,
    upcoming: [],
    stale: false,
  };
  if (!opts.connected) return base;

  const stale =
    !opts.lastSyncedAt || opts.now.getTime() - Date.parse(opts.lastSyncedAt) > STALE_AFTER_MS;
  const nowMs = opts.now.getTime();

  const timed = blocks
    .filter((b) => !b.allDay)
    .map((b) => ({ ...b, start: Date.parse(b.startsAt), end: Date.parse(b.endsAt) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const active = timed.filter((b) => b.start <= nowMs && nowMs < b.end);

  // Lo que queda por delante: lo que sigue vivo (en curso o por empezar) dentro del horizonte.
  const upcoming: UpcomingBlock[] = timed
    .filter((b) => b.end > nowMs && b.start - nowMs <= UPCOMING_WINDOW_MS)
    .slice(0, MAX_UPCOMING)
    .map((b) => ({
      title: b.title,
      startsAt: new Date(b.start).toISOString(),
      endsAt: new Date(b.end).toISOString(),
      current: b.start <= nowMs,
    }));

  if (!active.length) {
    const next = timed.find((b) => b.start > nowMs && b.start - nowMs <= LOOKAHEAD_MS);
    return {
      ...base,
      status: 'free',
      title: next?.title ?? null,
      nextStartsAt: next ? new Date(next.start).toISOString() : null,
      nextTitle: next?.title ?? null,
      upcoming,
      stale,
    };
  }

  // De los solapados manda el que empezó más tarde: es lo último en lo que la persona entró. Con
  // "Toy Dormido" (00:45–09:30) y "Sesion" (09:00–13:00) encimados, a las 09:15 está en la sesión.
  const current = active.reduce((a, b) => (b.start >= a.start ? b : a));

  // Lo siguiente que EMPIEZA, sin más. Antes se buscaba lo que venía tras encadenar todos los
  // bloques pegados, y eso saltaba por encima de los eventos intermedios: con la agenda de arriba
  // anunciaba las 16:30 cuando lo próximo de verdad eran las 09:00.
  const next = timed.find((b) => b.start > nowMs && b.start - nowMs <= LOOKAHEAD_MS);
  return {
    devId,
    status: 'busy',
    title: current.title,
    busyUntil: new Date(current.end).toISOString(),
    nextStartsAt: next ? new Date(next.start).toISOString() : null,
    nextTitle: next?.title ?? null,
    upcoming,
    stale,
  };
}

interface BlockRow {
  dev_id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
}

/**
 * Presencia de todos los devs con calendario conectado.
 *
 * Dos consultas y cero llamadas a Google: la lista de cuentas y una barrida de bloques de la ventana
 * vigente. Es lo que sondea el dashboard cada minuto, así que tiene que ser barata.
 */
export async function getTeamPresence(now = new Date()): Promise<DevPresence[]> {
  const { data: accounts } = await db()
    .from('dev_calendar_account')
    .select('dev_id, last_synced_at, status');
  const rows = (accounts as { dev_id: string; last_synced_at: string | null; status: string }[] | null) ?? [];
  if (!rows.length) return [];

  // Se pide desde un poco antes de ahora para no perder un bloque en curso que empezó temprano, y
  // hasta el lookahead para poder anunciar la próxima junta.
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + UPCOMING_WINDOW_MS).toISOString();

  const { data: blocks } = await db()
    .from('calendar_block')
    .select('dev_id, title, starts_at, ends_at, all_day')
    .in('dev_id', rows.map((r) => r.dev_id))
    .lt('starts_at', to)
    .gt('ends_at', from);

  const byDev = new Map<string, PresenceBlock[]>();
  for (const b of (blocks as BlockRow[] | null) ?? []) {
    const list = byDev.get(b.dev_id) ?? [];
    list.push({ title: b.title, startsAt: b.starts_at, endsAt: b.ends_at, allDay: b.all_day });
    byDev.set(b.dev_id, list);
  }

  return rows.map((r) =>
    derivePresence(r.dev_id, byDev.get(r.dev_id) ?? [], {
      now,
      // Una cuenta revocada sigue en la tabla para poder avisar "reconecta", pero ya no puede
      // sostener ningún estado: se reporta como desconocida.
      connected: r.status !== 'revoked',
      lastSyncedAt: r.last_synced_at,
    }),
  );
}
