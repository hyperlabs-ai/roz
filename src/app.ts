import { Hono } from 'hono';
import type { RozContext } from './types/hono.js';
import { loggerMiddleware } from './middleware/logger.js';
import { AppError } from './utils/errors.js';
import { mcpRoutes } from './routes/mcp.js';
import { webhookRoutes } from './routes/webhooks.js';
import { internalRoutes } from './routes/internal.js';

const app = new Hono<RozContext>();

// Health antes de cualquier middleware que pueda fallar.
app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'roz', ts: new Date().toISOString() }),
);

app.use('*', loggerMiddleware);

// Cara interactiva (Claude conversacional).
app.route('/mcp', mcpRoutes);
// Afuera -> roz.
app.route('/webhooks', webhookRoutes);
// Drenado de la cola (outbox) y barridas — disparado por Vercel Cron.
app.route('/v1/internal', internalRoutes);

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
