// Callback de OAuth2 de Discord (ligar la cuenta, contrato §B.9). Montado FUERA de /api/dashboard
// (`app.route('/api/discord', discordOauthRoutes)`) por la misma razón que /api/calendar/callback:
// es una navegación del navegador que hace Discord, sin Bearer. Se autentica con el `state` de un
// solo uso (roz.oauth_state, provider='discord'), que dice además de QUÉ dev es la cuenta, y que
// además tiene que coincidir con la cookie HttpOnly que /link/start dejó en ESE navegador.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { completeDiscordLink, linkRedirect, takeOAuthStateCookie } from '../discord/link.js';

export const discordOauthRoutes = new Hono<RozContext>();

discordOauthRoutes.get('/callback', async (c) => {
  const logger = c.get('logger');
  try {
    const outcome = await completeDiscordLink(
      { code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error'), cookieState: takeOAuthStateCookie(c) },
      (msg, extra) => logger?.warn(extra ?? {}, msg),
    );
    return c.redirect(linkRedirect(outcome), 302);
  } catch (err) {
    logger?.error({ err }, 'discord: callback de OAuth falló');
    return c.redirect(linkRedirect('error'), 302);
  }
});
