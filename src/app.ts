import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { RozContext } from './types/hono.js';
import { loggerMiddleware } from './middleware/logger.js';
import { AppError } from './utils/errors.js';
import { mcpRoutes } from './routes/mcp.js';
import { webhookRoutes } from './routes/webhooks.js';
import { intakeRoutes } from './routes/intake.js';
import { internalRoutes } from './routes/internal.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { calendarOauthRoutes } from './routes/calendar-oauth.js';
import { linearWebhookRoutes } from './routes/linear.js';
import { runnerRoutes } from './routes/runner.js';
import { discordOauthRoutes } from './routes/discord-oauth.js';
import { discordBridgeRoutes } from './routes/discord.js';
import { zeusCliRoutes } from './routes/zeus.js';
import { config } from './config.js';
import { runtimeStatus } from './runtime.js';
import { mountSpa } from './spa.js';

const app = new Hono<RozContext>();

// Health antes de cualquier middleware que pueda fallar.
// Siempre 200 mientras el proceso atienda: el puente de Discord caído NO debe tumbar el deploy del
// API (se reporta dentro, y el propio puente se reinicia solo).
app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'zeus', ts: new Date().toISOString(), ...runtimeStatus() }),
);

app.use('*', loggerMiddleware);

// CORS solo si se configuró un front en otro origen (ROZ_CORS_ORIGINS). Con el rewrite de Vercel el
// navegador ve un solo origen y esto queda apagado. La sesión viaja en Authorization, no en cookies.
if (config.cors.origins.length) {
  app.use(
    '/api/*',
    cors({
      origin: config.cors.origins,
      allowHeaders: ['authorization', 'content-type'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );
}

// Cara interactiva (Claude conversacional).
app.route('/mcp', mcpRoutes);
// Afuera -> roz.
app.route('/webhooks', webhookRoutes);
// Webhook de Linear (roz v2): POST /webhooks/linear. Con ROZ_LINEAR_SOT apagado responde 200 sin emitir.
app.route('/webhooks', linearWebhookRoutes);
// Ingesta automática desde apps de clientes (sin humano en el loop).
app.route('/v1/intake', intakeRoutes);
// API de roz-runner (roz v2): autentica su propio Bearer rozr_…, sin sesión del dashboard.
app.route('/v1/runner', runnerRoutes);
// CLI de zeus en la PC de cada dev (bóveda de llaves): autentica su token zeus_… por persona.
app.route('/v1/zeus', zeusCliRoutes);
// Dashboard de visibilidad de ingeniería (auth de OpsHyper). Lo consume el SPA en web/.
app.route('/api/dashboard', dashboardRoutes);
// Callback de OAuth de Google (calendario). Va aparte de /api/dashboard porque ese router exige
// Bearer en TODO, y esto llega como navegación del browser: se autentica con el `state` de un solo uso.
app.route('/api/calendar', calendarOauthRoutes);
// Callback de OAuth2 de Discord (ligar la cuenta del dev). Mismo motivo que el de calendario:
// llega como navegación del browser y se autentica con el `state` de un solo uso.
app.route('/api/discord', discordOauthRoutes);
// Drenado de la cola (outbox) y barridas — las dispara el planificador en proceso (src/jobs).
app.route('/v1/internal', internalRoutes);
// Avisos del puente de Discord (POST /v1/internal/discord/events). Trae su propia auth
// (Bearer ROZ_BRIDGE_SECRET, fail-closed) y responde 404 con ROZ_DISCORD_CHAT apagado.
app.route('/v1/internal', discordBridgeRoutes);

// SPA del dashboard: en producción lo sirve Vercel; aquí solo si hay un build local (self-host).
mountSpa(app);

app.onError((err, c) => {
  const logger = c.get('logger');
  if (err instanceof AppError) {
    logger?.warn({ code: err.code, err: err.message }, 'app error');
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  logger?.error({ err }, 'unhandled error');
  return c.json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } }, 500);
});

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));

export default app;
