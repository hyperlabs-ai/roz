// Endpoints internos disparados por Vercel Cron (ver vercel.json). Se autentican con un secreto
// compartido: al setear CRON_SECRET en Vercel, Vercel inyecta `Authorization: Bearer <CRON_SECRET>`
// en cada invocación de cron. Validamos ese bearer SIEMPRE (no depende del entorno) en tiempo
// constante. Sin secreto configurado se rechaza todo (fail-closed) — nunca abierto.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { secureEqual, bearerToken } from '../utils/secure-compare.js';
import { drainOutbox } from '../events/outbox.js';
import { brainSweep } from '../brain/sweep.js';
import { sendWeeklyDigest, sendDevWeeklyDigests } from '../notify/digest.js';
import { pollInfra } from '../infra/poll.js';

export const internalRoutes = new Hono<RozContext>();

function requireCron(c: { req: { header: (k: string) => string | undefined } }): boolean {
  if (!config.cron.secret) return false; // fail-closed: sin secreto, ningún cron se ejecuta
  return secureEqual(bearerToken(c.req.header('authorization')), config.cron.secret);
}

// Drena el outbox: la "cola async" sin servicio externo. Procesa pendientes y reintenta
// los fallidos cuyo backoff ya venció. Corre cada minuto (vercel.json).
internalRoutes.get('/drain', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await drainOutbox();
  c.get('logger')?.info(result, 'outbox drained');
  return c.json({ ok: true, ...result });
});

// Barrida diaria de consistencia del brain: rellena embeddings faltantes (skills/átomos).
internalRoutes.get('/brain-sweep', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await brainSweep();
  c.get('logger')?.info(result, 'brain swept');
  return c.json({ ok: true, ...result });
});

// Sondeo de infraestructura: estado de deploys/salud de Vercel/Railway/Supabase por servicio.
// Guarda un snapshot por servicio para que el dashboard lea sin pegarle a las APIs externas.
internalRoutes.get('/infra-poll', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await pollInfra();
  c.get('logger')?.info(result, 'infra polled');
  return c.json({ ok: true, ...result });
});

// Digest semanal por email: resumen de la semana con botón al dashboard. Lo dispara el cron
// los viernes en la noche (vercel.json). Destinatarios y URL en config (DIGEST_RECIPIENTS,
// DASHBOARD_URL).
internalRoutes.get('/weekly-digest', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  // Digest de equipo (a fer/destinatarios) + digest personal por dev (resumen de su propio trabajo).
  const [team, perDev] = await Promise.all([sendWeeklyDigest(), sendDevWeeklyDigests()]);
  c.get('logger')?.info({ team, perDev }, 'weekly digest sent');
  return c.json({ ok: true, team, perDev });
});
