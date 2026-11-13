// Endpoints internos disparados por Vercel Cron (ver vercel.json). Se autentican con un secreto
// compartido: al setear CRON_SECRET en Vercel, Vercel inyecta `Authorization: Bearer <CRON_SECRET>`
// en cada invocación de cron. Validamos ese bearer SIEMPRE (no depende del entorno) en tiempo
// constante. Sin secreto configurado se rechaza todo (fail-closed) — nunca abierto.
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { secureEqual, bearerToken } from '../utils/secure-compare.js';
import { drainOutbox } from '../events/outbox.js';
import { recordJobRun } from '../events/job-run.js';
import { brainSweep } from '../brain/sweep.js';
import { sendWeeklyDigest, sendDevWeeklyDigests } from '../notify/digest.js';
import { notifyDueTasks } from '../notify/notifications.js';
import { pollInfra } from '../infra/poll.js';
import { pollCalendars } from '../calendar/poll.js';
import { reconcileOpsBridge, auditOpsBridge } from '../reconcile/ops-bridge.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { scheduleLinearReconcile } from '../linear/reconcile.js';
import { pollGranola } from '../meetings/granola.js';
import { runPlanWatchdog } from '../plans/service.js';
import { discordChatEnabled, DISCORD_CHAT_DISABLED_CODE } from '../discord/enabled.js';
import { bridgeAuthorized } from './discord.js';
import { InteractionEnvelopeSchema, failureCallback, routeInteraction } from '../discord/commands/router.js';
import { syncGuildCommands } from '../discord/commands/register.js';
import { definitionsHash, commandDefinitions } from '../discord/commands/definitions.js';
import type { DiscordInteractionEnvelope } from '../discord/commands/types.js';
import { inBackground } from '../utils/background.js';
import { AppError } from '../utils/errors.js';
import { zeusSweep } from '../zeus/ingest.js';

export const internalRoutes = new Hono<RozContext>();

function requireCron(c: { req: { header: (k: string) => string | undefined } }): boolean {
  if (!config.cron.secret) return false; // fail-closed: sin secreto, ningún cron se ejecuta
  return secureEqual(bearerToken(c.req.header('authorization')), config.cron.secret);
}

// Drena el outbox: la "cola async" sin servicio externo. Procesa pendientes y reintenta
// los fallidos cuyo backoff ya venció. Corre cada minuto (vercel.json).
internalRoutes.get('/drain', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  // Se registra cada corrida (éxito o fallo) para que el dashboard pueda decir "último ciclo hace
  // 40s". Con la cola vacía —el caso normal— es la ÚNICA señal de que el cron sigue vivo.
  const t0 = Date.now();
  try {
    const result = await drainOutbox();
    await recordJobRun('drain', { durationMs: Date.now() - t0, result });
    c.get('logger')?.info(result, 'outbox drained');
    return c.json({ ok: true, ...result });
  } catch (err) {
    await recordJobRun('drain', { durationMs: Date.now() - t0, error: String(err) });
    throw err;
  }
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

// Sondeo de Google Calendar: cachea la agenda de cada dev conectado en roz.calendar_block, para que
// el dashboard derive "ocupado hasta las 11:30" sin pegarle a Google.
//
// Se registra la corrida por la misma razón que el drain: un calendario que dejó de sincronizarse
// se ve idéntico a un equipo que no tiene juntas, y solo el latido distingue los dos casos.
internalRoutes.get('/calendar-poll', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  const t0 = Date.now();
  try {
    const result = await pollCalendars();
    await recordJobRun('calendar-poll', { durationMs: Date.now() - t0, result });
    c.get('logger')?.info(result, 'calendars polled');
    return c.json({ ok: true, ...result });
  } catch (err) {
    await recordJobRun('calendar-poll', { durationMs: Date.now() - t0, error: String(err) });
    throw err;
  }
});

// Respaldo del puente Ops ⇄ roz. El camino normal son los triggers (migración 0021); esto solo
// recoge lo que ningún evento pudo disparar — sobre todo tareas ya asignadas a un dev que acaba
// de activarse. Audita, repara y vuelve a auditar: si `converged` sale false, la reparación no
// alcanzó y hay que mirarlo a mano.
//
// Con ROZ_LINEAR_SOT encendido las tareas viven en Linear y su red es /linear-reconcile: este cron se
// salta. Con el flag apagado corre exactamente igual que siempre.
internalRoutes.get('/ops-bridge', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  if (linearSourceOfTruth()) return c.json({ ok: true, skipped: 'linear_sot' });
  const result = await reconcileOpsBridge();
  if (!result.converged) c.get('logger')?.error(result, 'ops bridge no convergió');
  else if (result.repaired > 0) c.get('logger')?.warn(result, 'ops bridge reparado');
  return c.json({ ok: result.converged, ...result });
});

// Diagnóstico sin efectos, para revisar el puente sin repararlo.
internalRoutes.get('/ops-bridge/audit', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  return c.json({ ok: true, ...(await auditOpsBridge()) });
});

// ---- roz v2 ----
// Los tres responden { skipped: 'flag' } con ROZ_LINEAR_SOT apagado, sin tocar la base ni APIs.
// Se registra la corrida (como el drain) para distinguir "no hubo nada" de "el cron no corre".

/** Corre un job de cron registrando su latido en job_run, con éxito o con error. */
async function cronJob<T>(name: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await run();
    await recordJobRun(name, { durationMs: Date.now() - t0, result });
    return result;
  } catch (err) {
    await recordJobRun(name, { durationMs: Date.now() - t0, error: String(err) });
    throw err;
  }
}

// Reconciliación con Linear cada 30 min: encola un 'linear.reconcile' por tick (el drain lo procesa).
// Es la red del webhook de Linear y sustituye a /ops-bridge cuando el flag está encendido.
internalRoutes.get('/linear-reconcile', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  if (!linearSourceOfTruth()) return c.json({ ok: true, skipped: 'flag' });
  return c.json(await cronJob('linear-reconcile', () => scheduleLinearReconcile()));
});

// Sondeo de Granola cada 5 min (opcional: sin GRANOLA_API_KEY se salta sin tocar la red).
internalRoutes.get('/granola-poll', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  // Sin flag de Linear: las juntas funcionan con o sin él; pollGranola se salta solo sin llave.
  const logger = c.get('logger');
  return c.json(await cronJob('granola-poll', () => pollGranola({ log: (m, d) => logger?.info(d, m) })));
});

// Watchdog de planes cada 5 min: lo que no late regresa a la cola; lo atorado se marca reclamable.
internalRoutes.get('/plan-watchdog', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  if (!linearSourceOfTruth()) return c.json({ ok: true, requeued: 0, claimable: 0, skipped: 'flag' });
  const result = await cronJob('plan-watchdog', () => runPlanWatchdog());
  return c.json({ ok: true, ...result });
});

// Barrida de zeus cada 10 min: lee los repos que tuvieron push (o que llevan un día sin leerse) e
// importa los ADR/OpenSpec que zeus todavía no tiene; lo que ya está en el registro no se pisa.
// Acotada por ciclo; sin GITHUB_TOKEN se salta.
internalRoutes.get('/zeus-sweep', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await cronJob('zeus-sweep', () => zeusSweep());
  if (result.failed.length) c.get('logger')?.warn({ failed: result.failed }, 'zeus: repos que no se pudieron ingerir');
  return c.json({ ok: true, ...result });
});

// ---- comandos de roz en Discord (/roz, acciones de mensaje) ----
// Contrato: docs/discord-commands-contract.md. Las interacciones llegan al PUENTE por el gateway; el
// puente las reenvía aquí con ROZ_BRIDGE_SECRET y manda a Discord el `callback` que roz devuelve. Lo
// que no cabe en los 3 s de Discord se completa en segundo plano con el token de la interacción.
// Mismo criterio que /discord/events: flag apagado → 404; bearer malo o secreto vacío → 403.

const discordDisabled = (c: any) =>
  c.json({ error: { code: DISCORD_CHAT_DISABLED_CODE, message: 'El chat de Discord no está activado en este servidor.' } }, 404);

internalRoutes.post('/discord/interactions', async (c) => {
  if (!discordChatEnabled()) return discordDisabled(c);
  if (!bridgeAuthorized(c.req.header('authorization'))) return c.json({ error: 'forbidden' }, 403);
  const parsed = InteractionEnvelopeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'interacción inválida' } }, 400);
  if (parsed.data.guildId !== config.discord.guildId) return c.json({ error: 'forbidden' }, 403);
  const envelope = parsed.data as unknown as DiscordInteractionEnvelope;
  const logger = c.get('logger');
  // Nunca se loguea el token ni el contenido: tipo, ruta y tiempos bastan para diagnosticar.
  const log = (msg: string, extra?: Record<string, unknown>) => logger?.warn({ ...extra, interactionId: envelope.interaction.id }, msg);
  try {
    const t0 = Date.now();
    const outcome = await routeInteraction(envelope, { log });
    if (outcome.after) {
      const after = outcome.after;
      inBackground(after, (err) => log('discord: no se pudo completar la interacción', { route: outcome.route, err: err instanceof Error ? err.message : String(err) }));
    }
    logger?.info({ interactionId: envelope.interaction.id, route: outcome.route, ms: Date.now() - t0, callbackType: outcome.callback.type }, 'discord: interacción');
    return c.json({ callback: outcome.callback });
  } catch (err) {
    logger?.error({ err: err instanceof Error ? err.message : String(err), interactionId: envelope.interaction.id }, 'discord: el router de interacciones falló');
    // 200 con un callback de error: el usuario ve "algo falló" en vez de "la aplicación no respondió".
    return c.json({ callback: failureCallback(envelope.interaction.type) });
  }
});

// Registro idempotente de los comandos en el servidor (el puente lo llama al arrancar). ?force=1
// registra aunque el hash coincida; ?dryRun=1 solo dice si cambiaría.
internalRoutes.post('/discord/commands/sync', async (c) => {
  if (!discordChatEnabled()) return discordDisabled(c);
  if (!bridgeAuthorized(c.req.header('authorization'))) return c.json({ error: 'forbidden' }, 403);
  try {
    const result = await syncGuildCommands({ force: c.req.query('force') === '1', dryRun: c.req.query('dryRun') === '1' });
    c.get('logger')?.info(result, 'discord: comandos sincronizados');
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 500);
    c.get('logger')?.error({ err: err instanceof Error ? err.message : String(err) }, 'discord: no se pudieron registrar los comandos');
    return c.json({ error: { code: 'DISCORD_COMMANDS_SYNC_FAILED', message: 'no se pudieron registrar los comandos' } }, 502);
  }
});

// Definición vigente (diagnóstico del puente / del compositor): hash + comandos.
internalRoutes.get('/discord/commands', (c) => {
  if (!discordChatEnabled()) return discordDisabled(c);
  if (!bridgeAuthorized(c.req.header('authorization'))) return c.json({ error: 'forbidden' }, 403);
  return c.json({ hash: definitionsHash(), commands: commandDefinitions() });
});

// Digest semanal por email: resumen de la semana con botón al dashboard. Lo dispara el cron
// los viernes en la noche (vercel.json). Destinatarios y URL en config (DIGEST_RECIPIENTS,
// DASHBOARD_URL).
// Recordatorio diario de fechas: a cada dev, un push con lo que le vence hoy y lo ya vencido.
// Días hábiles a las 15:00 UTC (9:00 en México). Idempotente por dev y día.
internalRoutes.get('/task-reminders', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  const result = await notifyDueTasks();
  c.get('logger')?.info(result, 'task reminders sent');
  return c.json({ ok: true, ...result });
});

internalRoutes.get('/weekly-digest', async (c) => {
  if (!requireCron(c)) return c.json({ error: 'forbidden' }, 403);
  // Digest de equipo (a fer/destinatarios) + digest personal por dev (resumen de su propio trabajo).
  const [team, perDev] = await Promise.all([sendWeeklyDigest(), sendDevWeeklyDigests()]);
  c.get('logger')?.info({ team, perDev }, 'weekly digest sent');
  return c.json({ ok: true, team, perDev });
});
