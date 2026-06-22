// API del dashboard de visibilidad de ingeniería. Montada en /api/dashboard. Todo va detrás
// del auth de OpsHyper (requireDashboardAuth); las mutaciones (CRUD de skills) además exigen
// rol admin. El SPA nunca toca el schema `roz` directo: lee/escribe por aquí, y el service_role
// se queda server-side.
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { requireDashboardAuth, requireAdmin } from '../auth/verify.js';
import {
  type Period,
  currentMonthPeriod,
  getOverview,
  listDevelopers,
  getDeveloper,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  addProjectRepo,
  removeProjectRepo,
  listInfra,
  linkService,
  updateService,
  unlinkService,
  getTickets,
  getTicketFilters,
  getSkillCatalog,
  getSkillsMatrix,
  createSkill,
  updateSkill,
  deleteSkill,
  setDevSkill,
  removeDevSkill,
  setDevAvailability,
} from '../dashboard/queries.js';

export const dashboardRoutes = new Hono<RozContext>();

// Todo el dashboard requiere sesión válida (dominio permitido).
dashboardRoutes.use('*', requireDashboardAuth);

/** Resuelve el período desde ?from=&to= (ISO). Sin parámetros → mes actual. */
function period(c: { req: { query: (k: string) => string | undefined } }): Period {
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && to) return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  return currentMonthPeriod();
}

/** Período de comparación desde ?compareFrom=&compareTo=. Ausente → sin comparación (null). */
function comparePeriod(c: { req: { query: (k: string) => string | undefined } }): Period | null {
  const from = c.req.query('compareFrom');
  const to = c.req.query('compareTo');
  if (from && to) return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  return null;
}

// Mensaje legible de cualquier error. Los errores de Supabase (PostgrestError) son objetos planos
// (sin toString útil) → String(err) daría "[object Object]"; extraemos message/details/hint.
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [e.message, e.details, e.hint].filter(Boolean);
    if (parts.length) return e.code ? `${parts.join(' — ')} (${e.code})` : parts.join(' — ');
    try {
      return JSON.stringify(err);
    } catch {
      return 'error desconocido';
    }
  }
  return String(err);
}

function fail(c: any, err: unknown) {
  c.get('logger')?.error({ err }, 'dashboard error');
  return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
}

// Quién soy (para el header del SPA).
dashboardRoutes.get('/me', (c) => c.json({ user: c.get('user') }));

// Overview / landing del CEO.
dashboardRoutes.get('/overview', async (c) => {
  try {
    return c.json(await getOverview(period(c), comparePeriod(c)));
  } catch (err) {
    return fail(c, err);
  }
});

// Grid de developers.
dashboardRoutes.get('/developers', async (c) => {
  try {
    return c.json({ developers: await listDevelopers(period(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

// Perfil de un developer.
dashboardRoutes.get('/developers/:id', async (c) => {
  try {
    const data = await getDeveloper(c.req.param('id'), period(c), comparePeriod(c));
    if (!data) return c.json({ error: { code: 'NOT_FOUND', message: 'developer no existe' } }, 404);
    return c.json(data);
  } catch (err) {
    return fail(c, err);
  }
});

// Ajustar disponibilidad (admin). Afecta al router de asignación de roz.
const AvailabilityBody = z.object({ availability: z.number().min(0).max(1) });

dashboardRoutes.patch('/developers/:id/availability', requireAdmin, async (c) => {
  const parsed = AvailabilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json(await setDevAvailability(c.req.param('id'), parsed.data.availability));
  } catch (err) {
    return fail(c, err);
  }
});

// Proyectos: lista + detalle (historial de commits, líneas, contribuidores).
dashboardRoutes.get('/projects', async (c) => {
  try {
    return c.json({ projects: await listProjects(period(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

// Crear un proyecto manual (admin). La key se autogenera del nombre si no se manda.
const ProjectCreate = z.object({
  name: z.string().min(1),
  key: z.string().min(1).optional(),
  kind: z.enum(['client', 'internal']).optional(),
});

dashboardRoutes.post('/projects', requireAdmin, async (c) => {
  const parsed = ProjectCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ project: await createProject(parsed.data) }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.get('/projects/:id', async (c) => {
  try {
    const data = await getProject(c.req.param('id'), period(c));
    if (!data) return c.json({ error: { code: 'NOT_FOUND', message: 'proyecto no existe' } }, 404);
    return c.json(data);
  } catch (err) {
    return fail(c, err);
  }
});

// Gestión de repos del proyecto (admin).
const RepoBody = z.object({ repo: z.string().min(1) });

dashboardRoutes.post('/projects/:id/repos', requireAdmin, async (c) => {
  const parsed = RepoBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    await addProjectRepo(c.req.param('id'), parsed.data.repo);
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.delete('/projects/:id/repos', requireAdmin, async (c) => {
  const repo = c.req.query('repo');
  if (!repo) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'falta ?repo=' } }, 400);
  try {
    await removeProjectRepo(c.req.param('id'), repo);
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

// Editar nombre / key / tipo cliente-interno (admin). Todos los campos son opcionales.
const ProjectPatch = z
  .object({
    name: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    kind: z.enum(['client', 'internal']).optional(),
  })
  .refine((b) => b.name !== undefined || b.key !== undefined || b.kind !== undefined, 'sin cambios');

dashboardRoutes.patch('/projects/:id', requireAdmin, async (c) => {
  const parsed = ProjectPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ project: await updateProject(c.req.param('id'), parsed.data) });
  } catch (err) {
    return fail(c, err);
  }
});

// Borrar un proyecto (admin). Acción destructiva; el front exige escribir el nombre.
dashboardRoutes.delete('/projects/:id', requireAdmin, async (c) => {
  try {
    await deleteProject(c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

// Infraestructura: estado de deploys/salud por proyecto (último snapshot que escribió el cron).
dashboardRoutes.get('/infra', async (c) => {
  try {
    return c.json(await listInfra());
  } catch (err) {
    return fail(c, err);
  }
});

// Vincular / desvincular un servicio externo a un proyecto (admin).
const ServiceBody = z.object({
  provider: z.enum(['vercel', 'railway', 'supabase']),
  externalRef: z.string().min(1),
  label: z.string().nullish(),
  config: z.record(z.unknown()).optional(),
});

dashboardRoutes.post('/projects/:id/services', requireAdmin, async (c) => {
  const parsed = ServiceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ service: await linkService(c.req.param('id'), parsed.data) }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

const ServicePatch = z.object({
  provider: z.enum(['vercel', 'railway', 'supabase']).optional(),
  externalRef: z.string().min(1).optional(),
  label: z.string().nullish(),
  config: z.record(z.unknown()).optional(),
});

dashboardRoutes.patch('/projects/:id/services/:serviceId', requireAdmin, async (c) => {
  const parsed = ServicePatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ service: await updateService(c.req.param('serviceId'), parsed.data) });
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.delete('/projects/:id/services/:serviceId', requireAdmin, async (c) => {
  try {
    await unlinkService(c.req.param('serviceId'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

// Tickets (espejo de Linear): lista filtrable + agregaciones, y opciones de filtro.
dashboardRoutes.get('/tickets', async (c) => {
  try {
    return c.json(
      await getTickets({
        projectId: c.req.query('projectId'),
        state: c.req.query('state'),
        assigneeDevId: c.req.query('assignee'),
        priority: c.req.query('priority'),
        scope: c.req.query('scope') === 'all' ? 'all' : 'open',
      }),
    );
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.get('/tickets/filters', async (c) => {
  try {
    return c.json(await getTicketFilters());
  } catch (err) {
    return fail(c, err);
  }
});

// Skills: catálogo + matriz (lectura).
dashboardRoutes.get('/skills', async (c) => {
  try {
    return c.json({ skills: await getSkillCatalog() });
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.get('/skills/matrix', async (c) => {
  try {
    return c.json(await getSkillsMatrix());
  } catch (err) {
    return fail(c, err);
  }
});

// ---- Mutaciones (requieren admin) ----

const SkillBody = z.object({ tag: z.string().min(1), description: z.string().nullish() });

dashboardRoutes.post('/skills', requireAdmin, async (c) => {
  const parsed = SkillBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ skill: await createSkill(parsed.data.tag, parsed.data.description ?? null) }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

const SkillPatch = z.object({ tag: z.string().min(1).optional(), description: z.string().nullish() });

dashboardRoutes.patch('/skills/:id', requireAdmin, async (c) => {
  const parsed = SkillPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ skill: await updateSkill(c.req.param('id'), parsed.data) });
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.delete('/skills/:id', requireAdmin, async (c) => {
  try {
    await deleteSkill(c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

const DevSkillBody = z.object({ skillId: z.string().uuid(), level: z.number().int().min(1).max(5) });

dashboardRoutes.post('/devs/:devId/skills', requireAdmin, async (c) => {
  const parsed = DevSkillBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    await setDevSkill(c.req.param('devId'), parsed.data.skillId, parsed.data.level);
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.delete('/devs/:devId/skills/:skillId', requireAdmin, async (c) => {
  try {
    await removeDevSkill(c.req.param('devId'), c.req.param('skillId'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});
