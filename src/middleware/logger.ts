import { pino } from 'pino';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config.js';
import type { RozContext } from '../types/hono.js';

const base = pino({ level: config.logLevel });

let counter = 0;

export const loggerMiddleware: MiddlewareHandler<RozContext> = async (c, next) => {
  // ID determinista por proceso (Math.random no está disponible en algunos sandboxes).
  const requestId = `req_${Date.now().toString(36)}_${(counter++).toString(36)}`;
  const logger = base.child({ requestId, method: c.req.method, path: c.req.path });
  c.set('logger', logger);
  c.set('requestId', requestId);

  const start = Date.now();
  await next();
  logger.info({ status: c.res.status, ms: Date.now() - start }, 'request');
};
