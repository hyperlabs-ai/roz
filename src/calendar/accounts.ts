// Cuentas de Google conectadas por dev: guardado cifrado, renovación del access token y el `state`
// de un solo uso del flujo OAuth.
//
// Todo lo que toca `refresh_token` pasa por aquí; ni las rutas ni el poll manipulan la credencial
// en claro más allá del momento de usarla.
import { randomBytes } from 'node:crypto';
import { db } from '../db/supabase.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import {
  GoogleAuthRevokedError,
  refreshAccessToken,
  revokeToken,
  type GoogleTokens,
} from '../adapters/google-calendar.js';

/** Margen antes de que expire el access token. Renovar justo en el filo deja requests a medio vuelo. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Vida del `state` de OAuth. Es el tiempo que tarda alguien en dar clic y consentir, no más. */
const STATE_TTL_MS = 10 * 60 * 1000;

export interface CalendarAccountRow {
  id: string;
  dev_id: string;
  auth_user_id: string | null;
  google_email: string | null;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: string | null;
  scope: string | null;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
}

const COLUMNS =
  'id, dev_id, auth_user_id, google_email, refresh_token_enc, access_token_enc, access_expires_at, scope, status, last_error, last_synced_at';

export async function getAccount(devId: string): Promise<CalendarAccountRow | null> {
  const { data } = await db().from('dev_calendar_account').select(COLUMNS).eq('dev_id', devId).maybeSingle();
  return (data as CalendarAccountRow | null) ?? null;
}

/** Todas las cuentas que el sondeo debe intentar. Las `revoked` quedan fuera hasta que se reconecten. */
export async function listSyncableAccounts(): Promise<CalendarAccountRow[]> {
  const { data, error } = await db().from('dev_calendar_account').select(COLUMNS).neq('status', 'revoked');
  if (error) throw new Error(`no se pudieron listar las cuentas de calendario: ${error.message}`);
  return (data as CalendarAccountRow[] | null) ?? [];
}

/**
 * Guarda (o reemplaza) la conexión de un dev tras un consentimiento exitoso.
 *
 * `onConflict: 'dev_id'` en vez de insert: reconectar es el camino normal cuando alguien revoca el
 * acceso o cambia de cuenta, y debe pisar la conexión anterior en vez de fallar.
 */
export async function saveAccount(input: {
  devId: string;
  authUserId: string | null;
  googleEmail: string | null;
  tokens: GoogleTokens;
}): Promise<void> {
  if (!input.tokens.refreshToken) {
    throw new Error('Google no devolvió refresh_token: la conexión no sobreviviría a la primera hora');
  }
  const { error } = await db()
    .from('dev_calendar_account')
    .upsert(
      {
        dev_id: input.devId,
        auth_user_id: input.authUserId,
        google_email: input.googleEmail,
        refresh_token_enc: encryptSecret(input.tokens.refreshToken),
        access_token_enc: encryptSecret(input.tokens.accessToken),
        access_expires_at: input.tokens.expiresAt,
        scope: input.tokens.scope,
        status: 'active',
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'dev_id' },
    );
  if (error) throw new Error(`no se pudo guardar la cuenta de calendario: ${error.message}`);
}

/**
 * Un access token utilizable para esta cuenta, renovándolo si está por vencer.
 *
 * Si Google dice que el permiso ya no existe, la cuenta se marca `revoked` y el error se propaga:
 * el llamador decide si eso tumba su corrida (una sola cuenta) o solo salta a la siguiente.
 */
export async function accessTokenFor(account: CalendarAccountRow): Promise<string> {
  const expiresAt = account.access_expires_at ? Date.parse(account.access_expires_at) : 0;
  if (account.access_token_enc && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return decryptSecret(account.access_token_enc);
  }

  const refreshToken = decryptSecret(account.refresh_token_enc);
  try {
    const fresh = await refreshAccessToken(refreshToken);
    await db()
      .from('dev_calendar_account')
      .update({
        access_token_enc: encryptSecret(fresh.accessToken),
        access_expires_at: fresh.expiresAt,
        status: 'active',
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', account.id);
    return fresh.accessToken;
  } catch (err) {
    if (err instanceof GoogleAuthRevokedError) await markRevoked(account.id, String(err.message));
    throw err;
  }
}

export async function markRevoked(accountId: string, reason: string): Promise<void> {
  await db()
    .from('dev_calendar_account')
    .update({ status: 'revoked', last_error: reason, updated_at: new Date().toISOString() })
    .eq('id', accountId);
}

export async function markError(accountId: string, reason: string): Promise<void> {
  await db()
    .from('dev_calendar_account')
    .update({ status: 'error', last_error: reason, updated_at: new Date().toISOString() })
    .eq('id', accountId);
}

export async function markSynced(accountId: string): Promise<void> {
  const now = new Date().toISOString();
  await db()
    .from('dev_calendar_account')
    .update({ status: 'active', last_error: null, last_synced_at: now, updated_at: now })
    .eq('id', accountId);
}

/**
 * Desconecta: revoca en Google y borra la cuenta y sus bloques.
 *
 * Los bloques se borran a propósito y no se dejan envejecer — son títulos de eventos de una agenda
 * personal, y quien desconecta está pidiendo justamente que roz deje de tenerlos.
 */
export async function disconnectAccount(devId: string): Promise<boolean> {
  const account = await getAccount(devId);
  if (!account) return false;

  try {
    await revokeToken(decryptSecret(account.refresh_token_enc));
  } catch {
    // Si el token ya no es válido, revocarlo tampoco lo sería. El borrado local es lo que importa.
  }
  await db().from('calendar_block').delete().eq('dev_id', devId);
  await db().from('dev_calendar_account').delete().eq('dev_id', devId);
  return true;
}

// ---------- `state` del flujo OAuth ----------

/**
 * Crea un `state` de un solo uso que transporta la identidad del dev hasta el callback.
 *
 * Hace falta porque el SPA se autentica con Bearer JWT, y el redirect de Google al callback es una
 * navegación del browser que no lleva ese header: sin esto, el callback no sabría de quién es el
 * calendario que acaba de autorizarse.
 */
export async function createOAuthState(devId: string, authUserId: string | null): Promise<string> {
  const state = randomBytes(32).toString('hex');
  const { error } = await db().from('oauth_state').insert({
    state,
    provider: 'google',
    dev_id: devId,
    auth_user_id: authUserId,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`no se pudo crear el state de OAuth: ${error.message}`);
  return state;
}

export interface OAuthStateRow {
  state: string;
  dev_id: string;
  auth_user_id: string | null;
  expires_at: string;
  used_at: string | null;
}

/** Motivo por el que un `state` no sirve, o null si es válido. Separado para poder testearlo puro. */
export function stateRejection(row: OAuthStateRow | null, now = new Date()): string | null {
  if (!row) return 'desconocido';
  if (row.used_at) return 'ya usado';
  if (Date.parse(row.expires_at) <= now.getTime()) return 'expirado';
  return null;
}

/**
 * Consume el `state`: lo valida y lo marca usado en un solo paso.
 *
 * El `update ... is('used_at', null)` es lo que hace atómico el consumo: si dos callbacks llegan a
 * la vez con el mismo state (un doble clic, un reintento del browser), solo uno actualiza la fila.
 */
export async function consumeOAuthState(
  state: string,
): Promise<{ ok: true; row: OAuthStateRow } | { ok: false; reason: string }> {
  const { data } = await db()
    .from('oauth_state')
    .select('state, dev_id, auth_user_id, expires_at, used_at')
    .eq('state', state)
    .maybeSingle();

  const row = (data as OAuthStateRow | null) ?? null;
  const rejection = stateRejection(row);
  if (rejection || !row) return { ok: false, reason: rejection ?? 'desconocido' };

  const { data: claimed } = await db()
    .from('oauth_state')
    .update({ used_at: new Date().toISOString() })
    .eq('state', state)
    .is('used_at', null)
    .select('state')
    .maybeSingle();
  if (!claimed) return { ok: false, reason: 'ya usado' };

  return { ok: true, row };
}

/** Limpia los states vencidos. Lo llama el mismo cron del sondeo; no merece un cron propio. */
export async function purgeExpiredStates(): Promise<void> {
  await db()
    .from('oauth_state')
    .delete()
    .lt('expires_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .then(undefined, () => {});
}
