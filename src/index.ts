// Server local para desarrollo. En producción Vercel usa api/index.ts.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';
import { config } from './config.js';
import { drainOutbox, localV2Drain, ROZ_V2_EVENT_TYPES } from './events/outbox.js';

if (config.env !== 'production') {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    // eslint-disable-next-line no-console
    console.log(`roz dev server → http://localhost:${info.port}`);
  });

  // Red de seguridad del modo de prueba local (ver localV2Drain en src/events/outbox.ts): drena
  // SOLO los eventos v2 cada 5 s, para ganarle al drain de producción, que corre cada minuto con un
  // código que todavía no los conoce. Los demás eventos los sigue procesando producción.
  if (localV2Drain()) {
    let running = false;
    setInterval(() => {
      if (running) return;
      running = true;
      drainOutbox(20, { types: ROZ_V2_EVENT_TYPES })
        .catch((err) => console.error('[dev drain v2]', err))
        .finally(() => {
          running = false;
        });
    }, 5000);
    // eslint-disable-next-line no-console
    console.log('roz dev: eventos v2 se procesan en local (ROZ_DEV_DRAIN_V2=false para apagarlo)');
  }
}

export default app;
