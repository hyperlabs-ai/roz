// Sondeo de Google Calendar: recorre las cuentas conectadas, trae la agenda de cada dev y la guarda
// en roz.calendar_block. Lo dispara el cron /v1/internal/calendar-poll (ver vercel.json).
//
// Calcado de src/infra/poll.ts, con la misma división de trabajo: este cron es lo ÚNICO que le pega
// a Google; el dashboard lee la caché. No pasa por el outbox porque, como el sondeo de
// infraestructura, su reintento natural es la corrida siguiente.
import { db } from '../db/supabase.js';
import {
  GoogleAuthRevokedError,
  googleConfigured,
  listCalendars,
  listEvents,
} from '../adapters/google-calendar.js';
import {
  accessTokenFor,
  listSyncableAccounts,
  markError,
  markRevoked,
  markSynced,
  purgeExpiredStates,
  type CalendarAccountRow,
} from './accounts.js';

/**
 * Ventana que se cachea.
 *
 * Hacia atrás una hora: para no perder una junta larga que empezó antes de la corrida. Hacia
 * adelante 36 horas: cubre "lo que queda de hoy y todo mañana", que es lo que el dashboard puede
 * llegar a anunciar, sin traer una agenda entera que nadie va a mirar.
 */
const WINDOW_BACK_MS = 60 * 60 * 1000;
const WINDOW_AHEAD_MS = 36 * 60 * 60 * 1000;

/**
 * Antigüedad a la que se tira un bloque ya terminado.
 *
 * El barrido por corrida solo limpia DENTRO de la ventana, así que sin esto la tabla acumularía para
 * siempre los títulos de todos los eventos de todas las agendas. Nada lee el pasado —la presencia
 * mira el ahora y lo que viene— y guardar la agenda histórica de la gente no es algo que roz deba
 * hacer sin que nadie se lo haya pedido.
 */
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export interface CalendarPollResult {
  accounts: number;
  synced: number;
  blocks: number;
  revoked: number;
  failed: number;
  skipped?: string;
}

/** Sincroniza una cuenta. Devuelve cuántos bloques quedaron en la ventana. */
async function syncAccount(account: CalendarAccountRow, now: Date): Promise<number> {
  const token = await accessTokenFor(account);
  const timeMin = new Date(now.getTime() - WINDOW_BACK_MS);
  const timeMax = new Date(now.getTime() + WINDOW_AHEAD_MS);
  const syncedAt = now.toISOString();

  const calendars = await listCalendars(token);
  const rows: Record<string, unknown>[] = [];
  for (const cal of calendars) {
    const events = await listEvents(token, cal.id, timeMin, timeMax);
    for (const e of events) {
      rows.push({
        dev_id: account.dev_id,
        calendar_id: cal.id,
        google_event_id: e.id,
        title: e.title,
        starts_at: e.startsAt,
        ends_at: e.endsAt,
        all_day: e.allDay,
        event_status: e.status,
        synced_at: syncedAt,
      });
    }
  }

  if (rows.length) {
    const { error } = await db()
      .from('calendar_block')
      .upsert(rows, { onConflict: 'dev_id,calendar_id,google_event_id' });
    if (error) throw new Error(`no se pudieron guardar los bloques: ${error.message}`);
  }

  // Barrer lo que esta corrida no volvió a ver dentro de la ventana: eventos borrados, movidos o que
  // dejaron de ocupar. Se hace DESPUÉS del upsert, no antes, para que nunca exista un instante en el
  // que el dev aparezca libre a media junta.
  const { error: sweepError } = await db()
    .from('calendar_block')
    .delete()
    .eq('dev_id', account.dev_id)
    .lt('synced_at', syncedAt)
    .lt('starts_at', timeMax.toISOString())
    .gt('ends_at', timeMin.toISOString());
  if (sweepError) throw new Error(`no se pudieron limpiar los bloques viejos: ${sweepError.message}`);

  await markSynced(account.id);
  return rows.length;
}

/** Tira los bloques ya vencidos. Best-effort: es limpieza, no puede tumbar el sondeo. */
async function purgeOldBlocks(now: Date): Promise<void> {
  await db()
    .from('calendar_block')
    .delete()
    .lt('ends_at', new Date(now.getTime() - RETENTION_MS).toISOString())
    .then(undefined, () => {});
}

/**
 * Una pasada por todas las cuentas conectadas.
 *
 * Cada cuenta se aísla: que a una persona se le haya revocado el acceso no puede dejar sin estado al
 * resto del equipo.
 */
export async function pollCalendars(now = new Date()): Promise<CalendarPollResult> {
  const empty: CalendarPollResult = { accounts: 0, synced: 0, blocks: 0, revoked: 0, failed: 0 };
  if (!googleConfigured()) return { ...empty, skipped: 'Google Calendar no configurado' };

  await purgeExpiredStates();
  await purgeOldBlocks(now);

  const accounts = await listSyncableAccounts();
  const result: CalendarPollResult = { ...empty, accounts: accounts.length };

  for (const account of accounts) {
    try {
      result.blocks += await syncAccount(account, now);
      result.synced += 1;
    } catch (err) {
      if (err instanceof GoogleAuthRevokedError) {
        // `accessTokenFor` ya la marcó si el fallo vino del refresh; esto cubre el 401 al leer.
        await markRevoked(account.id, String(err.message));
        result.revoked += 1;
      } else {
        await markError(account.id, err instanceof Error ? err.message : String(err));
        result.failed += 1;
      }
    }
  }

  return result;
}

/**
 * Sincroniza una sola cuenta, recién conectada.
 *
 * Existe para que el estado aparezca en cuanto alguien conecta su calendario, en vez de dejarlo
 * mirando un dashboard vacío hasta cinco minutos. Best-effort: si falla, el cron lo recoge.
 */
export async function syncDevCalendar(account: CalendarAccountRow, now = new Date()): Promise<void> {
  try {
    await syncAccount(account, now);
  } catch (err) {
    if (err instanceof GoogleAuthRevokedError) await markRevoked(account.id, String(err.message));
    else await markError(account.id, err instanceof Error ? err.message : String(err));
  }
}
