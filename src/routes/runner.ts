// API del runner (roz-runner en la PC de cada dev). Montada en app.ts como /v1/runner. Fuera del
// dashboard: no hay sesión de usuario, autentica el token del runner (Authorization: Bearer rozr_…,
// se compara su sha256). Cada request válida sella runner.last_seen_at. Polling saliente: roz nunca
// le habla al runner, el runner pregunta.
// Con ROZ_LINEAR_SOT apagado → 409 LINEAR_SOT_OFF (antes incluso de autenticar: no hay nada que hacer).
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { errMessage } from './http.js';
import { AppError } from '../utils/errors.js';
import { bearerToken } from '../utils/secure-compare.js';
import { assertPlansEnabled } from '../plans/store.js';
import {
  authenticateRunner,
  heartbeatSchema,
  progressSchema,
  pullSchema,
  registerRunner,
  registerSchema,
  runnerHeartbeat,
  runnerNextJob,
  runnerProgress,
  runnerPull,
  type AuthedRunner,
} from '../plans/runners.js';
import type { RunnerProgressRequest, RunnerRegisterRequest } from '../types/roz-v2.js';

type RunnerEnv = RozContext & { Variables: RozContext['Variables'] & { runnerAuth?: AuthedRunner } };

export const runnerRoutes = new Hono<RunnerEnv>();

function fail(c: any, err: unknown) {
  if (err instanceof AppError) {
    c.get('logger')?.warn({ code: err.code, err: err.message }, 'runner app error');
    const body: { code: string; message: string; details?: unknown } = { code: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return c.json({ error: body }, err.status as 400);
  }
  c.get('logger')?.error({ err }, 'runner error');
  return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
}

function invalid(c: any, error: z.ZodError) {
  return c.json({ error: { code: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? 'datos inválidos', details: error.issues } }, 400);
}

runnerRoutes.use('*', async (c, next) => {
  try {
    assertPlansEnabled();
    c.set('runnerAuth', await authenticateRunner(bearerToken(c.req.header('authorization'))));
  } catch (err) {
    return fail(c, err);
  }
  await next();
});

const authOf = (c: { get: (k: 'runnerAuth') => AuthedRunner | undefined }) => c.get('runnerAuth')!;

async function jsonBody(c: any): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

runnerRoutes.post('/register', async (c) => {
  try {
    const parsed = registerSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { name, version, platform, schedule, maxConcurrent } = parsed.data;
    const body: RunnerRegisterRequest = { name: name!, version: version!, platform: platform! };
    if (schedule) body.schedule = { tz: schedule.tz!, days: schedule.days!, start: schedule.start!, end: schedule.end! };
    if (maxConcurrent !== undefined) body.maxConcurrent = maxConcurrent;
    return c.json(await registerRunner(authOf(c), body));
  } catch (err) {
    return fail(c, err);
  }
});

runnerRoutes.post('/heartbeat', async (c) => {
  try {
    const parsed = heartbeatSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { running, version } = parsed.data;
    return c.json(
      await runnerHeartbeat(authOf(c), {
        running: (running ?? []).map((r) => ({
          planId: r.planId!,
          leaseId: r.leaseId!,
          progress: r.progress
            ? { step: r.progress.step ?? null, message: r.progress.message ?? null, pct: r.progress.pct ?? null }
            : undefined,
        })),
        version,
      }),
    );
  } catch (err) {
    return fail(c, err);
  }
});

runnerRoutes.post('/next-job', async (c) => {
  try {
    return c.json(await runnerNextJob(authOf(c)));
  } catch (err) {
    return fail(c, err);
  }
});

runnerRoutes.post('/progress', async (c) => {
  try {
    const parsed = progressSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { planId, leaseId, kind, ...rest } = parsed.data;
    const body: RunnerProgressRequest = { planId: planId!, leaseId: leaseId!, kind: kind!, ...rest };
    const auth = authOf(c);
    return c.json(await runnerProgress(auth.runner.id, auth.dev.id, body));
  } catch (err) {
    return fail(c, err);
  }
});

runnerRoutes.post('/pull', async (c) => {
  try {
    const parsed = pullSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { planId, identifier } = parsed.data;
    return c.json(await runnerPull(authOf(c), { planId, identifier }));
  } catch (err) {
    return fail(c, err);
  }
});
