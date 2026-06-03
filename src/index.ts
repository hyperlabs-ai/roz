// Server local para desarrollo. En producción Vercel usa api/index.ts.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';
import { config } from './config.js';

if (config.env !== 'production') {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    // eslint-disable-next-line no-console
    console.log(`roz dev server → http://localhost:${info.port}`);
  });
}

export default app;
