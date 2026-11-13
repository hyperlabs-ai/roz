// Arranque de zeus: el back de roz como UN proceso de larga vida (Railway, Docker o local).
//
// En el mismo proceso viven el API (Hono), el MCP, el planificador que sustituye a los crons de
// Vercel y el gateway de Discord. El front (web/) se despliega aparte como estático en Vercel y le
// habla a este proceso por /api (ver vercel.json).
import 'dotenv/config';
import { serve } from '@hono/node-server';
import pino from 'pino';
import app from './app.js';
import { config } from './config.js';
import { drainOutbox, localV2Drain, ROZ_V2_EVENT_TYPES } from './events/outbox.js';
import { startScheduler, type Scheduler } from './jobs/scheduler.js';
import { embeddedBridgeEnabled, startEmbeddedBridge, type EmbeddedBridge } from './bridge/embedded.js';
import { setRuntime } from './runtime.js';
import { drainBackground } from './utils/background.js';

const log = pino({ level: config.logLevel, base: { service: 'zeus' } });
const appFetch = (req: Request) => app.fetch(req);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info({ port: info.port, env: config.env }, 'zeus escuchando');
});

let scheduler: Scheduler | null = null;
if (config.scheduler.enabled) {
  if (!config.cron.secret) {
    log.error('ROZ_SCHEDULER está encendido pero falta CRON_SECRET: el planificador no arranca');
  } else {
    scheduler = startScheduler(appFetch, { log: (level, msg, data) => log[level](data ?? {}, msg) });
  }
}

// Modo de prueba local contra la base compartida (ver localV2Drain en src/events/outbox.ts): sin
// planificador, se drenan SOLO los eventos v2 cada 5 s. Los demás los procesa el zeus de producción.
let devDrain: NodeJS.Timeout | null = null;
if (!scheduler && localV2Drain()) {
  let running = false;
  devDrain = setInterval(() => {
    if (running) return;
    running = true;
    drainOutbox(20, { types: ROZ_V2_EVENT_TYPES })
      .catch((err) => log.error({ err }, 'dev drain v2'))
      .finally(() => {
        running = false;
      });
  }, 5000);
  log.info('dev: los eventos v2 se procesan en local (ROZ_DEV_DRAIN_V2=false para apagarlo)');
}

let bridge: EmbeddedBridge | null = null;
if (embeddedBridgeEnabled()) {
  bridge = startEmbeddedBridge(appFetch);
  log.info('puente de Discord en este proceso');
}

setRuntime({
  scheduler: () => !!scheduler,
  bridge: () => (bridge ? bridge.health() : null),
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'apagando');
  const force = setTimeout(() => {
    log.error('el apagado tardó demasiado; saliendo a la fuerza');
    process.exit(1);
  }, 40_000);
  force.unref();
  try {
    if (devDrain) clearInterval(devDrain);
    // Primero dejar de aceptar tráfico y de disparar jobs; después esperar lo que ya corría.
    server.close();
    await Promise.allSettled([scheduler?.stop(), bridge?.stop()]);
    await drainBackground(10_000);
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({ err }, 'promesa rechazada sin manejar'));
