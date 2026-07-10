import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { RozContext } from './types/hono.js';
import { loggerMiddleware } from './middleware/logger.js';
import { AppError } from './utils/errors.js';
import { mcpRoutes } from './routes/mcp.js';
import { webhookRoutes } from './routes/webhooks.js';
import { intakeRoutes } from './routes/intake.js';
import { internalRoutes } from './routes/internal.js';
import { dashboardRoutes } from './routes/dashboard.js';

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
// Ingesta automática desde apps de clientes (sin humano en el loop).
app.route('/v1/intake', intakeRoutes);
// Dashboard de visibilidad de ingeniería (auth de OpsHyper). Lo consume el SPA en web/.
app.route('/api/dashboard', dashboardRoutes);
// Drenado de la cola (outbox) y barridas — disparado por Vercel Cron.
app.route('/v1/internal', internalRoutes);

// --- SPA del dashboard ---
// La función sirve el build de web/dist (incluido en el bundle vía vercel.json includeFiles).
// Resolución robusta del directorio: el cwd de la función serverless en Vercel no es fijo, así
// que probamos rutas candidatas (LAMBDA_TASK_ROOT, cwd, ..) y elegimos donde exista index.html.
// Lectura manual por ruta absoluta (no serveStatic, que depende del cwd).
const SPA_DIST = (() => {
  const candidates = [
    process.env.LAMBDA_TASK_ROOT ? join(process.env.LAMBDA_TASK_ROOT, 'web/dist') : '',
    join(process.cwd(), 'web/dist'),
    join(process.cwd(), '../web/dist'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? candidates[candidates.length - 1]!;
})();

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

// El service worker y el manifest NO deben cachearse de forma agresiva: el navegador debe poder
// detectar una versión nueva del SW en cada visita para actualizar la PWA.
const NO_CACHE = new Set(['sw.js', 'manifest.webmanifest']);

// Estáticos hasheados (inmutables) desde /assets.
app.get('/assets/*', async (c) => {
  const rel = c.req.path.replace(/^\/+/, ''); // "assets/xxx"
  try {
    const buf = await readFile(join(SPA_DIST, rel));
    return c.body(buf, 200, {
      'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    });
  } catch {
    return c.notFound();
  }
});

// Fallback del SPA. Si la ruta tiene extensión (favicon, /roz.png y demás de web/public que
// el build copia a dist), se sirve ese archivo; si no existe o no tiene extensión, cae al
// index.html para que resuelva el router del lado cliente.
app.get('*', async (c) => {
  const rel = c.req.path.replace(/^\/+/, '');
  if (rel && extname(rel)) {
    try {
      const buf = await readFile(join(SPA_DIST, rel));
      return c.body(buf, 200, {
        'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
        'cache-control': NO_CACHE.has(rel) ? 'no-cache' : 'public, max-age=3600',
        // El SW debe poder controlar todo el origen, no solo /assets.
        ...(rel === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
      });
    } catch {
      /* no es un archivo del build: cae al SPA */
    }
  }
  try {
    return c.html(await readFile(join(SPA_DIST, 'index.html'), 'utf8'));
  } catch {
    return c.text('SPA build no encontrado', 500);
  }
});

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
