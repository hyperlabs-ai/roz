// API del dashboard para los planes del agente y los runners (roz v2). Se montan DENTRO de
// dashboardRoutes (ya pasaron por requireDashboardAuth): la persona sale SIEMPRE de la sesión.
//   /api/dashboard/plans*    → planRoutes
//   /api/dashboard/runners*  → runnerDashboardRoutes
// Con ROZ_LINEAR_SOT apagado todo responde 409 LINEAR_SOT_OFF (lo lanza el servicio).
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { errMessage } from './http.js';
import { AppError } from '../utils/errors.js';
import { PLAN_STATUSES, type PlanStatus } from '../types/roz-v2.js';
import {
  approvePlan,
  cancelPlan,
  claimPlan,
  getPlanDetail,
  listPlans,
  pullPlan,
  releasePlan,
  requestChanges,
} from '../plans/service.js';
import { FEEDBACK_MAX, type PlanScope } from '../plans/service.js';
import { toSummaryOne } from '../plans/store.js';
import {
  createRunner,
  listRunners,
  maxConcurrentSchema,
  revokeRunner,
  runnerNameSchema,
  scheduleSchema,
  updateRunner,
} from '../plans/runners.js';

export const planRoutes = new Hono<RozContext>();
export const runnerDashboardRoutes = new Hono<RozContext>();

/** Como fail() de http.ts, pero conserva `details` (PLAN_CONFLICT / PLAN_TAKEN los necesitan en el front). */
function fail(c: any, err: unknown) {
  if (err instanceof AppError) {
    c.get('logger')?.warn({ code: err.code, err: err.message }, 'plans app error');
    const body: { code: string; message: string; details?: unknown } = { code: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return c.json({ error: body }, err.status as 400);
  }
  c.get('logger')?.error({ err }, 'plans error');
  return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
}

function invalid(c: any, error: z.ZodError) {
  return c.json({ error: { code: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? 'datos inválidos', details: error.issues } }, 400);
}

const actorOf = (c: { get: (k: 'user') => RozContext['Variables']['user'] }) => {
  const user = c.get('user')!;
  return { userId: user.id, devId: user.devId };
};

/** Para runners: además del dev, el rol (un admin puede revocar el runner de otro). */
const runnerActorOf = (c: { get: (k: 'user') => RozContext['Variables']['user'] }) => {
  const user = c.get('user')!;
  return { devId: user.devId, role: user.role };
};

async function jsonBody(c: any): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

// ================================================================ planes

const SCOPES: PlanScope[] = ['mine', 'team', 'claimable'];
const uuid = z.string().uuid();

planRoutes.get('/', async (c) => {
  try {
    const scopeQ = c.req.query('scope') ?? 'mine';
    if (!SCOPES.includes(scopeQ as PlanScope)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'scope inválido' } }, 400);
    const statusQ = c.req.query('status');
    if (statusQ && !PLAN_STATUSES.includes(statusQ as PlanStatus)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'status inválido' } }, 400);
    }
    const devId = c.req.query('devId');
    const projectId = c.req.query('projectId');
    if ((devId && !uuid.safeParse(devId).success) || (projectId && !uuid.safeParse(projectId).success)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'id inválido' } }, 400);
    }
    const { devId: viewerDevId } = actorOf(c);
    return c.json(
      await listPlans({
        viewerDevId,
        scope: scopeQ as PlanScope,
        status: statusQ as PlanStatus | undefined,
        devId: devId || undefined,
        projectId: projectId || undefined,
      }),
    );
  } catch (err) {
    return fail(c, err);
  }
});

planRoutes.get('/:id', async (c) => {
  try {
    if (!uuid.safeParse(c.req.param('id')).success) return c.json({ error: { code: 'NOT_FOUND', message: 'Ese plan no existe.' } }, 404);
    return c.json({ plan: await getPlanDetail(c.req.param('id'), actorOf(c).devId) });
  } catch (err) {
    return fail(c, err);
  }
});

planRoutes.post('/:id/approve', async (c) => {
  try {
    return c.json({ plan: await approvePlan(c.req.param('id'), actorOf(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

const changesSchema = z.object({ feedback: z.string().trim().min(1, 'Escribe qué cambios necesita el plan.').max(FEEDBACK_MAX) });
planRoutes.post('/:id/request-changes', async (c) => {
  try {
    const parsed = changesSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { feedback } = parsed.data;
    return c.json({ plan: await requestChanges(c.req.param('id'), actorOf(c), feedback!) });
  } catch (err) {
    return fail(c, err);
  }
});

const claimSchema = z.object({ note: z.string().max(1000).nullish() });
planRoutes.post('/:id/claim', async (c) => {
  try {
    const parsed = claimSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return c.json({ plan: await claimPlan(c.req.param('id'), actorOf(c), parsed.data.note ?? null) });
  } catch (err) {
    return fail(c, err);
  }
});

planRoutes.post('/:id/pull', async (c) => {
  try {
    const actor = actorOf(c);
    const { plan, pull } = await pullPlan(c.req.param('id'), actor.devId);
    return c.json({ plan: await toSummaryOne(plan, actor.devId), pull });
  } catch (err) {
    return fail(c, err);
  }
});

planRoutes.post('/:id/release', async (c) => {
  try {
    return c.json({ plan: await releasePlan(c.req.param('id'), actorOf(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

const cancelSchema = z.object({ reason: z.string().max(1000).nullish() });
planRoutes.post('/:id/cancel', async (c) => {
  try {
    const parsed = cancelSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return c.json({ plan: await cancelPlan(c.req.param('id'), actorOf(c), parsed.data.reason ?? null) });
  } catch (err) {
    return fail(c, err);
  }
});

// ================================================================ runners (Configuración)

runnerDashboardRoutes.get('/', async (c) => {
  try {
    const all = c.req.query('all') === '1';
    return c.json({ runners: await listRunners({ devId: actorOf(c).devId, all }) });
  } catch (err) {
    return fail(c, err);
  }
});

const createRunnerSchema = z.object({
  name: runnerNameSchema,
  schedule: scheduleSchema.optional(),
  maxConcurrent: maxConcurrentSchema.optional(),
});
runnerDashboardRoutes.post('/', async (c) => {
  try {
    const parsed = createRunnerSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { name, schedule, maxConcurrent } = parsed.data;
    const actor = actorOf(c);
    const out = await createRunner({ devId: actor.devId, userId: actor.userId, name: name!, schedule, maxConcurrent });
    // El token en claro SOLO viaja aquí: después solo queda su hash.
    return c.json(out, 201);
  } catch (err) {
    return fail(c, err);
  }
});

const patchRunnerSchema = z.object({
  name: runnerNameSchema.optional(),
  schedule: scheduleSchema.optional(),
  maxConcurrent: maxConcurrentSchema.optional(),
});
runnerDashboardRoutes.patch('/:id', async (c) => {
  try {
    if (!uuid.safeParse(c.req.param('id')).success) return c.json({ error: { code: 'NOT_FOUND', message: 'Ese runner no existe.' } }, 404);
    const parsed = patchRunnerSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { name, schedule, maxConcurrent } = parsed.data;
    return c.json({ runner: await updateRunner(c.req.param('id'), { name, schedule, maxConcurrent }, runnerActorOf(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

runnerDashboardRoutes.delete('/:id', async (c) => {
  try {
    if (!uuid.safeParse(c.req.param('id')).success) return c.json({ error: { code: 'NOT_FOUND', message: 'Ese runner no existe.' } }, 404);
    return c.json({ runner: await revokeRunner(c.req.param('id'), runnerActorOf(c)) });
  } catch (err) {
    return fail(c, err);
  }
});
