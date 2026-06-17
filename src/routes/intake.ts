// Endpoint público de ingesta para apps de clientes. Un solo endpoint al que se conectan
// TODOS los proyectos: la app manda la solicitud del cliente, roz la documenta con Claude,
// la auto-asigna y la enruta a Linear (sin humano en el loop). Autenticado por bearer
// ROZ_INGEST_TOKEN (compartido entre apps; el proyecto se distingue por projectKey).
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { autoIngest } from '../intake/auto.js';
import { AppError } from '../utils/errors.js';

export const intakeRoutes = new Hono<RozContext>();

const BodySchema = z.object({
  projectKey: z.string().min(1),
  description: z.string().min(8, 'description: mínimo 8 caracteres'),
  app: z.string().min(1).optional(), // si no, se usa el header X-Roz-App
  customer: z.string().optional(),
  title: z.string().optional(),
  attachments: z.array(z.string()).optional(),
});

intakeRoutes.post('/', async (c) => {
  // Auth.
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!config.ingest.token || token !== config.ingest.token) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'token inválido' } }, 401);
  }

  const json = await c.req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  }
  // Tomar `data` y guardar con `!data`: narrowing robusto a cualquier config del compilador
  // (no depende de la inferencia del discriminated-union ni de strictNullChecks).
  const data = parsed.data;
  if (!data) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'cuerpo inválido' } }, 400);
  }

  // El nombre de la app puede venir en el body o en un header (cómodo para los SDKs).
  const app = data.app ?? c.req.header('x-roz-app') ?? 'app de cliente';

  try {
    const result = await autoIngest({
      projectKey: data.projectKey,
      description: data.description,
      app,
      customer: data.customer,
      title: data.title,
      attachments: data.attachments,
    });
    c.get('logger')?.info({ identifier: result.identifier, app }, 'auto-ingest ok');
    return c.json({ ok: true, ...result }, 201);
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    c.get('logger')?.error({ err, app }, 'auto-ingest failed');
    return c.json({ error: { code: 'INTERNAL', message: String(err) } }, 500);
  }
});
