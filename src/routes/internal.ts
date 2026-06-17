// Endpoints internos disparados por Vercel Cron (ver vercel.json). Vercel firma sus crons
// con el header `x-vercel-cron`; rechazamos cualquier otra cosa en producción.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { drainOutbox } from '../events/outbox.js';
import { brainSweep } from '../brain/sweep.js';

export const internalRoutes = new Hono<RozContext>();

function isVercelCron(c: { req: { header: (k: string) => string | undefined } }): boolean {
  if (config.env !== 'production') return true;
  return c.req.header('x-vercel-cron') != null;
}

// Drena el outbox: la "cola async" sin servicio externo. Procesa pendientes y reintenta
// los fallidos cuyo backoff ya venció. Corre cada minuto (vercel.json).
internalRoutes.get('/drain', async (c) => {
  if (!isVercelCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await drainOutbox();
  c.get('logger')?.info(result, 'outbox drained');
  return c.json({ ok: true, ...result });
});

// Barrida diaria de consistencia del brain: rellena embeddings faltantes (skills/átomos).
internalRoutes.get('/brain-sweep', async (c) => {
  if (!isVercelCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await brainSweep();
  c.get('logger')?.info(result, 'brain swept');
  return c.json({ ok: true, ...result });
});

// Digest semanal por email — aún no implementado (no hay modelo de destinatarios). El cron
// NO está agendado en vercel.json para no ejecutar un no-op; el endpoint queda para correrlo
// a mano cuando se defina el alcance.
internalRoutes.get('/digest', async (c) => {
  if (!isVercelCron(c)) return c.json({ error: 'forbidden' }, 403);
  return c.json({ ok: true, implemented: false });
});
