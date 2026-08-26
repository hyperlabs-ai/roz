// Callback de OAuth de Google. Montado FUERA de /api/dashboard a propósito.
//
// `dashboardRoutes` aplica requireDashboardAuth a todo (`dashboardRoutes.use('*', ...)`), y aquí no
// hay Bearer que valer: esto es una navegación del browser que hace el propio Google al terminar el
// consentimiento. Su autenticación es el `state` de un solo uso creado al iniciar el flujo, que es
// también lo que dice de QUÉ dev es el calendario que se acaba de autorizar.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { exchangeCode, googleConfigured, primaryEmail } from '../adapters/google-calendar.js';
import { consumeOAuthState, getAccount, saveAccount } from '../calendar/accounts.js';
import { syncDevCalendar } from '../calendar/poll.js';

export const calendarOauthRoutes = new Hono<RozContext>();

/**
 * Vuelta a Configuración con el desenlace.
 *
 * Redirect RELATIVO, no absoluto sobre DASHBOARD_URL como hacen los correos: la misma función sirve
 * el SPA, y DASHBOARD_URL está vacía en local — un absoluto rompería el flujo justo donde más se
 * prueba. El motivo va acotado y sin datos del error real para no reflejar nada en la URL.
 */
function back(reason: 'ok' | 'denied' | 'state' | 'error'): string {
  return `/app/settings?calendar=${reason}`;
}

calendarOauthRoutes.get('/callback', async (c) => {
  const logger = c.get('logger');
  if (!googleConfigured()) return c.redirect(back('error'), 302);

  // El usuario le dio "Cancelar" en la pantalla de Google. No es un fallo: se regresa en silencio.
  if (c.req.query('error')) return c.redirect(back('denied'), 302);

  const code = c.req.query('code') ?? '';
  const state = c.req.query('state') ?? '';
  if (!code || !state) return c.redirect(back('state'), 302);

  const claimed = await consumeOAuthState(state);
  if (!claimed.ok) {
    logger?.warn({ reason: claimed.reason }, 'state de OAuth rechazado');
    return c.redirect(back('state'), 302);
  }

  try {
    const tokens = await exchangeCode(code);
    const email = await primaryEmail(tokens.accessToken);
    await saveAccount({
      devId: claimed.row.dev_id,
      authUserId: claimed.row.auth_user_id,
      googleEmail: email,
      tokens,
    });

    // Primer sondeo inmediato: sin esto, quien acaba de conectar mira un dashboard sin su estado
    // hasta que corra el cron. Best-effort — si falla, el cron lo recoge en la siguiente pasada.
    const account = await getAccount(claimed.row.dev_id);
    if (account) await syncDevCalendar(account);

    return c.redirect(back('ok'), 302);
  } catch (err) {
    logger?.error({ err, devId: claimed.row.dev_id }, 'no se pudo completar el OAuth de Google');
    return c.redirect(back('error'), 302);
  }
});
