// API del dashboard de visibilidad de ingeniería. Montada en /api/dashboard. Todo va detrás
// del auth de OpsHyper (requireDashboardAuth); las mutaciones (CRUD de skills) además exigen
// rol admin. El SPA nunca toca el schema `roz` directo: lee/escribe por aquí, y el service_role
// se queda server-side.
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { requireDashboardAuth, requireAdmin } from '../auth/verify.js';
import { pushEnabled } from '../adapters/web-push.js';
import { savePushSubscription, deletePushSubscription } from '../notify/push.js';
import { getContributionCalendar, getRepo, listOrgRepos } from '../adapters/github.js';
import { enqueueRepoBackfill } from '../reconcile/backfill.js';
import {
  type Period,
  currentMonthPeriod,
  getOverview,
  listDevelopers,
  getDeveloper,
  listProjects,
  getProject,
  createProject,
  createDeveloper,
  getDeveloperCredentials,
  updateDeveloper,
  updateProject,
  deleteProject,
  addProjectRepo,
  normalizeRepo,
  removeProjectRepo,
  listProjectRepos,
  listActiveSyncs,
  listInfra,
  getInfraUptime,
  linkService,
  updateService,
  unlinkService,
  getTickets,
  getTicketFilters,
  createTask,
  updateTask,
  deleteTask,
  listTaskComments,
  addTaskComment,
  listAttachments,
  addAttachment,
  deleteAttachment,
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

// Alta de developer (admin). Las credenciales que arrancan su flujo: github_login/github_email
// (atribución) y email (notificaciones). name es lo único obligatorio; el resto es opcional pero
// recomendado. createDeveloper rechaza identidades duplicadas.
const DeveloperCreate = z.object({
  name: z.string().min(1),
  email: z.string().email().nullish(),
  githubLogin: z.string().min(1).nullish(),
  githubEmail: z.string().email().nullish(),
  availability: z.number().min(0).max(1).optional(),
});

dashboardRoutes.post('/developers', requireAdmin, async (c) => {
  const parsed = DeveloperCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    // name garantizado por el schema (min 1); z.infer lo marca opcional (ver fix "inferencia de
    // campos en dashboard"), así que se destructura y asevera como en createProject/linkService.
    const { name, email, githubLogin, githubEmail, availability } = parsed.data;
    return c.json(
      { developer: await createDeveloper({ name: name!, email, githubLogin, githubEmail, availability }) },
      201,
    );
  } catch (err) {
    return fail(c, err);
  }
});

// Credenciales editables de un developer (admin) — para prellenar el formulario de edición.
dashboardRoutes.get('/developers/:id/credentials', requireAdmin, async (c) => {
  try {
    const dev = await getDeveloperCredentials(c.req.param('id'));
    if (!dev) return c.json({ error: { code: 'NOT_FOUND', message: 'developer no existe' } }, 404);
    return c.json({ developer: dev });
  } catch (err) {
    return fail(c, err);
  }
});

// Editar credenciales de un developer (admin). Todos los campos opcionales; al guardar, re-atribuye
// su trabajo huérfano por la identidad de GitHub. `null` limpia un campo; ausente lo deja igual.
const DeveloperPatch = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().nullish(),
    githubLogin: z.string().min(1).nullish(),
    githubEmail: z.string().email().nullish(),
    availability: z.number().min(0).max(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'sin cambios');

dashboardRoutes.patch('/developers/:id', requireAdmin, async (c) => {
  const parsed = DeveloperPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ developer: await updateDeveloper(c.req.param('id'), parsed.data) });
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

// Cuadrícula de contribuciones de GitHub del developer (la del perfil público, últimos 12 meses).
// No es calculada por roz: viene directo de la GraphQL API de GitHub vía el PAT. Si el dev no tiene
// github_login o el usuario no existe en GitHub, devuelve linked:false (el front muestra vacío).
dashboardRoutes.get('/developers/:id/contributions', async (c) => {
  try {
    const dev = await getDeveloperCredentials(c.req.param('id'));
    if (!dev) return c.json({ error: { code: 'NOT_FOUND', message: 'developer no existe' } }, 404);
    if (!dev.githubLogin) return c.json({ linked: false, login: null, totalContributions: 0, weeks: [] });
    const to = new Date();
    const from = new Date(to);
    from.setFullYear(from.getFullYear() - 1);
    const cal = await getContributionCalendar(dev.githubLogin, from.toISOString(), to.toISOString());
    if (!cal) return c.json({ linked: false, login: dev.githubLogin, totalContributions: 0, weeks: [] });
    return c.json({ linked: true, login: dev.githubLogin, ...cal });
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
// Color: hex "#RGB"/"#RRGGBB" o null para limpiar (cae al color determinístico en el front).
const HexColor = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'color hex inválido');

const ProjectCreate = z.object({
  name: z.string().min(1),
  key: z.string().min(1).optional(),
  kind: z.enum(['client', 'internal']).optional(),
  color: HexColor.nullish(),
});

dashboardRoutes.post('/projects', requireAdmin, async (c) => {
  const parsed = ProjectCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    const { name, key, kind, color } = parsed.data; // name garantizado por el schema (min 1)
    return c.json({ project: await createProject({ name: name!, key, kind, color }) }, 201);
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
    const projectId = c.req.param('id');
    // Sella el id numérico inmutable (best-effort): ancla el vínculo para sobrevivir renames. Si el
    // repo es privado/inaccesible para el PAT, se vincula sin id y se sellará en el primer push/rename.
    const githubId = await getRepo(normalizeRepo(parsed.data.repo)).then((m) => m.githubId).catch(() => null);
    const repo = await addProjectRepo(projectId, parsed.data.repo, githubId);
    // Vincular en vivo solo trackea hacia adelante; recupera el historial reciente (BACKFILL_DAYS).
    await enqueueRepoBackfill(repo, projectId).catch(() => {});
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

// Re-sincronizar (admin): fuerza el backfill del historial saltándose la idempotencia once-only
// (force) y recalculando líneas con el filtro de generados. Con `repo` en el body re-sincroniza
// solo ese repo; sin él, todos los del proyecto. Recupera repos a medias y re-aplica el filtro.
const ResyncBody = z.object({ repo: z.string().min(1).optional() });
dashboardRoutes.post('/projects/:id/resync', requireAdmin, async (c) => {
  const parsed = ResyncBody.safeParse(await c.req.json().catch(() => ({})));
  const repoArg = parsed.success ? parsed.data.repo : undefined;
  try {
    const projectId = c.req.param('id');
    const repos = repoArg ? [normalizeRepo(repoArg)] : await listProjectRepos(projectId);
    await Promise.all(repos.map((repo) => enqueueRepoBackfill(repo, projectId, { force: true }).catch(() => {})));
    return c.json({ ok: true, repos: repos.length });
  } catch (err) {
    return fail(c, err);
  }
});

// Progreso de las sincronizaciones activas (para el widget global). Ligero: se puede pollear.
dashboardRoutes.get('/sync-status', requireAdmin, async (c) => {
  try {
    return c.json({ syncs: await listActiveSyncs() });
  } catch (err) {
    return fail(c, err);
  }
});

// Repos de la organización en GitHub, para el autocomplete al vincular (evita typos → 404 silencioso).
dashboardRoutes.get('/repos/available', requireAdmin, async (c) => {
  try {
    return c.json({ repos: await listOrgRepos() });
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
    color: HexColor.nullish(),
  })
  .refine((b) => b.name !== undefined || b.key !== undefined || b.kind !== undefined || b.color !== undefined, 'sin cambios');

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

// Timeline de disponibilidad (status page): ventana FIJA propia (todo el histórico retenido, ~14
// días), independiente del selector de período del dashboard. Acepta ?days para ampliarla.
dashboardRoutes.get('/infra/uptime', async (c) => {
  try {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days')) || 14));
    const to = new Date().toISOString();
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return c.json(await getInfraUptime({ from, to }));
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
    const { provider, externalRef, label, config } = parsed.data; // requeridos garantizados por el schema
    return c.json({ service: await linkService(c.req.param('id'), { provider: provider!, externalRef: externalRef!, label, config }) }, 201);
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

// ---- Web Push (notificaciones a la PWA) ----
// El SPA pide la public key VAPID, se suscribe con el service worker y registra la suscripción
// aquí. Las alertas de infraestructura (mismas que el correo) se envían a estas suscripciones.
dashboardRoutes.get('/push/public-key', (c) =>
  c.json({ publicKey: config.webPush.publicKey, enabled: pushEnabled() }),
);

const PushSubBody = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
  userAgent: z.string().nullish(),
});

dashboardRoutes.post('/push/subscribe', async (c) => {
  const parsed = PushSubBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  const user = c.get('user')!;
  // z.infer marca los campos requeridos como opcionales en el build de prod → reconstruimos el
  // objeto con `!` (garantizados por el schema) o el deploy no compila.
  const sub = parsed.data.subscription!;
  try {
    await savePushSubscription({
      authUserId: user.id,
      email: user.email ?? null,
      subscription: { endpoint: sub.endpoint!, keys: { p256dh: sub.keys!.p256dh!, auth: sub.keys!.auth! } },
      userAgent: parsed.data.userAgent ?? c.req.header('user-agent') ?? null,
    });
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

const PushUnsubBody = z.object({ endpoint: z.string().url() });

dashboardRoutes.post('/push/unsubscribe', async (c) => {
  const parsed = PushUnsubBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    await deletePushSubscription(parsed.data.endpoint!); // requerido garantizado por el schema
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

// Tareas / tickets: lista filtrable + agregaciones, y opciones de filtro. `from`/`to` acotan por
// fecha agendada (vista calendario); sin ellos, todo el conjunto (abierto por defecto).
dashboardRoutes.get('/tickets', async (c) => {
  try {
    return c.json(
      await getTickets({
        projectId: c.req.query('projectId'),
        state: c.req.query('state'),
        assigneeDevId: c.req.query('assignee'),
        priority: c.req.query('priority'),
        scope: c.req.query('scope') === 'all' ? 'all' : 'open',
        from: c.req.query('from'),
        to: c.req.query('to'),
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

// ---- CRUD de tareas nativas (cualquier usuario autenticado) ----

const TASK_STATE = z.enum(['backlog', 'unstarted', 'started', 'review', 'completed', 'canceled']);
const TASK_PRIORITY = z.enum(['urgent', 'high', 'medium', 'low']);

const TaskCreateBody = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1),
  spec: z.string().nullish(),
  state: TASK_STATE.optional(),
  priority: TASK_PRIORITY.nullish(),
  assigneeDevId: z.string().uuid().nullish(),
  assigneeDevIds: z.array(z.string().uuid()).optional(),
  scheduledStart: z.string().datetime({ offset: true }).nullish(),
  scheduledEnd: z.string().datetime({ offset: true }).nullish(),
  dueDate: z.string().nullish(),
  labels: z.array(z.string()).optional(),
  parentId: z.string().uuid().nullish(),
});

dashboardRoutes.post('/tickets', requireAdmin, async (c) => {
  const parsed = TaskCreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    // z.infer marca requeridos como opcionales en el build de prod → destructurar + `!`.
    const { projectId, title, spec, state, priority, assigneeDevId, assigneeDevIds, scheduledStart, scheduledEnd, dueDate, labels, parentId } = parsed.data;
    const task = await createTask({
      projectId: projectId!,
      title: title!,
      spec,
      state,
      priority,
      assigneeDevId,
      assigneeDevIds,
      scheduledStart,
      scheduledEnd,
      dueDate,
      labels,
      parentId,
      createdBy: c.get('user')?.id ?? null,
    });
    return c.json({ task }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

const TaskPatchBody = z
  .object({
    title: z.string().min(1).optional(),
    spec: z.string().nullish(),
    state: TASK_STATE.optional(),
    priority: TASK_PRIORITY.nullish(),
    assigneeDevId: z.string().uuid().nullish(),
    assigneeDevIds: z.array(z.string().uuid()).optional(),
    scheduledStart: z.string().datetime({ offset: true }).nullish(),
    scheduledEnd: z.string().datetime({ offset: true }).nullish(),
    dueDate: z.string().nullish(),
    labels: z.array(z.string()).optional(),
    parentId: z.string().uuid().nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, 'sin cambios');

dashboardRoutes.patch('/tickets/:id', requireAdmin, async (c) => {
  const parsed = TaskPatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ task: await updateTask(c.req.param('id'), parsed.data) });
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.delete('/tickets/:id', requireAdmin, async (c) => {
  try {
    await deleteTask(c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

// Comentarios de una tarea.
dashboardRoutes.get('/tickets/:id/comments', async (c) => {
  try {
    return c.json({ comments: await listTaskComments(c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

const CommentBody = z.object({ body: z.string().min(1), mentions: z.array(z.string().uuid()).optional() });

dashboardRoutes.post('/tickets/:id/comments', requireAdmin, async (c) => {
  const parsed = CommentBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    const user = c.get('user');
    const { body, mentions } = parsed.data;
    const comment = await addTaskComment(c.req.param('id'), {
      authorId: user?.id ?? null,
      authorName: user?.name ?? user?.email ?? null,
      body: body!,
      mentions,
    });
    return c.json({ comment }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

// Adjuntos (imágenes) de una tarea. Subida multipart; el backend sube a Storage (service_role).
const MAX_ATTACH_BYTES = 4 * 1024 * 1024; // 4MB (bajo el límite de body de la función serverless)

dashboardRoutes.get('/tickets/:id/attachments', async (c) => {
  try {
    return c.json({ attachments: await listAttachments(c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.post('/tickets/:id/attachments', requireAdmin, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'falta el archivo' } }, 400);
    if (!file.type.startsWith('image/')) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'solo se aceptan imágenes' } }, 400);
    if (file.size > MAX_ATTACH_BYTES) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'la imagen supera 4MB' } }, 400);
    const buf = Buffer.from(await file.arrayBuffer());
    const attachment = await addAttachment(c.req.param('id'), {
      body: buf,
      name: file.name || 'imagen',
      contentType: file.type,
      size: file.size,
      uploadedBy: c.get('user')?.id ?? null,
    });
    return c.json({ attachment }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

dashboardRoutes.delete('/tickets/:id/attachments/:attachmentId', requireAdmin, async (c) => {
  try {
    await deleteAttachment(c.req.param('attachmentId'));
    return c.json({ ok: true });
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
