// Endpoints internos disparados por Vercel Cron (ver vercel.json). Vercel firma sus crons
// con el header `x-vercel-cron`; rechazamos cualquier otra cosa en producción.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { drainOutbox } from '../events/outbox.js';
import { brainSweep } from '../brain/sweep.js';
import { sendWeeklyDigest } from '../notify/digest.js';
import { pollInfra } from '../infra/poll.js';

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

// Sondeo de infraestructura: estado de deploys/salud de Vercel/Railway/Supabase por servicio.
// Guarda un snapshot por servicio para que el dashboard lea sin pegarle a las APIs externas.
internalRoutes.get('/infra-poll', async (c) => {
  if (!isVercelCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await pollInfra();
  c.get('logger')?.info(result, 'infra polled');
  return c.json({ ok: true, ...result });
});

// Digest semanal por email: resumen de la semana con botón al dashboard. Lo dispara el cron
// los viernes en la noche (vercel.json). Destinatarios y URL en config (DIGEST_RECIPIENTS,
// DASHBOARD_URL).
internalRoutes.get('/weekly-digest', async (c) => {
  if (!isVercelCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await sendWeeklyDigest();
  c.get('logger')?.info(result, 'weekly digest sent');
  return c.json({ ok: true, ...result });
});
