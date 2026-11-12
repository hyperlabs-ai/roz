// API de juntas. Montada en /api/dashboard/meetings DENTRO de dashboardRoutes
// (`dashboardRoutes.route('/meetings', meetingRoutes)`), así que ya pasó por requireDashboardAuth:
// quién decide sale SIEMPRE de la sesión, nunca del body. Contrato: docs/roz-v2-contracts.md §b.
//
// Las juntas funcionan con o sin ROZ_LINEAR_SOT (decisión del usuario: probarlas sin tocar Linear).
// Con el flag encendido, aceptar crea el issue en Linear; apagado, crea la tarea nativa en roz por el
// mismo camino que /ticket (ver acceptCandidate en src/meetings/service.ts).
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { OVERRIDE_CATEGORY_VALUES } from '../assign/rules.js';
import { granolaEnabled } from '../adapters/granola.js';
import {
  acceptCandidate,
  createMeeting,
  deleteMeeting,
  discardCandidate,
  getMeeting,
  listInbox,
  listMeetings,
  resolveProjectForEmails,
  retryMeeting,
  setMeetingProject,
  type MeetingUser,
} from '../meetings/service.js';
import { MEETING_TRANSCRIPT_MAX_CHARS, type MeetingStatus } from '../types/roz-v2.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { fail } from './http.js';

export const meetingRoutes = new Hono<RozContext>();

const MEETING_STATUSES = ['pendiente', 'extrayendo', 'lista', 'error'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(c: any, message: string) {
  return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
}

function meetingUser(c: { get: (k: 'user') => RozContext['Variables']['user'] }): MeetingUser {
  const u = c.get('user');
  if (!u?.devId) throw new AppError('NOT_REGISTERED', 'Necesitas un perfil de developer en roz', 403);
  return { id: u.id, devId: u.devId, devName: u.devName };
}

const UUID = z.string().uuid();

/** El :id de la ruta. Uno que no es uuid no existe (y Postgres lo rechazaría con un 500). */
function idParam(c: { req: { param: (k: 'id') => string } }, what: string): string {
  const id = c.req.param('id');
  if (!UUID.safeParse(id).success) throw new NotFoundError(`${what} no existe`);
  return id;
}

function logger(c: any) {
  const l = c.get('logger');
  return (msg: string, data: Record<string, unknown>) => l?.info(data, msg);
}


// ---------------------------------------------------------------- juntas

const ListQuery = z.object({
  status: z.enum(MEETING_STATUSES).optional(),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

meetingRoutes.get('/', async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const { status, projectId, limit } = parsed.data;
    const meetings = await listMeetings({ status: (status ?? null) as MeetingStatus | null, projectId: projectId ?? null, limit: limit ?? 30 });
    return c.json({ meetings, granolaEnabled: granolaEnabled() });
  } catch (err) {
    return fail(c, err);
  }
});

const Attendee = z.object({ name: z.string().max(200), email: z.string().max(320).nullish() });

const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  heldAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'fecha inválida'),
  durationMin: z.number().int().min(1).max(1440).nullish(),
  attendees: z.array(Attendee).max(100).default([]),
  projectId: z.string().uuid().nullish(),
  format: z.enum(['texto', 'vtt', 'srt', 'granola_resumen']),
  // Con holgura sobre el máximo: el límite real se aplica DESPUÉS de normalizar (marcas de tiempo fuera).
  content: z.string().min(1).max(MEETING_TRANSCRIPT_MAX_CHARS * 3),
  fileName: z.string().max(300).nullish(),
});

meetingRoutes.post('/', async (c) => {
  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const { title, heldAt, durationMin, attendees, projectId, format, content, fileName } = parsed.data;
    const meeting = await createMeeting(
      meetingUser(c),
      {
        title: title!,
        heldAt: heldAt!,
        durationMin: durationMin ?? null,
        attendees: (attendees ?? []).map((a) => ({ name: a.name!, email: a.email ?? null })),
        projectId: projectId ?? null,
        format: format!,
        content: content!,
        fileName: fileName ?? null,
      },
      { log: logger(c) },
    );
    return c.json({ meeting }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

// Antes de '/:id' (si no, "resolve-project" e "inbox" caerían como id).
meetingRoutes.get('/resolve-project', async (c) => {
  const emails = (c.req.query('emails') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, 100);
  try {
    return c.json(await resolveProjectForEmails(emails));
  } catch (err) {
    return fail(c, err);
  }
});

meetingRoutes.get('/inbox', async (c) => {
  const projectId = c.req.query('projectId');
  if (projectId && !z.string().uuid().safeParse(projectId).success) return invalid(c, 'projectId inválido');
  try {
    return c.json({ candidates: await listInbox({ projectId: projectId ?? null }) });
  } catch (err) {
    return fail(c, err);
  }
});

// ---------------------------------------------------------------- bandeja

const AcceptBody = z.object({
  mode: z.enum(['crear', 'comentar']).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(8000).nullish(),
  assigneeDevId: z.string().uuid().nullish(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullish(),
  estimate: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13)]).nullish(),
  solutionTypeId: z.string().uuid().nullish(),
  dueDate: z.string().regex(DATE_RE).nullish(),
  override: z.object({ category: z.enum(OVERRIDE_CATEGORY_VALUES), note: z.string().max(1000).nullish() }).optional(),
});

meetingRoutes.post('/candidates/:id/accept', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = AcceptBody.safeParse(raw ?? {});
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const b = parsed.data;
    // `undefined` = no lo tocó (se queda lo de la candidata); `null` = lo quitó. Por eso se mira la
    // llave en el body crudo y no solo el valor parseado.
    const has = (k: string) => raw !== null && typeof raw === 'object' && k in (raw as object);
    const result = await acceptCandidate(
      meetingUser(c),
      idParam(c, 'la candidata'),
      {
        mode: b.mode,
        title: b.title,
        ...(has('description') ? { description: b.description ?? null } : {}),
        ...(has('assigneeDevId') ? { assigneeDevId: b.assigneeDevId ?? null } : {}),
        ...(has('priority') ? { priority: b.priority ?? null } : {}),
        ...(has('estimate') ? { estimate: b.estimate ?? null } : {}),
        ...(has('solutionTypeId') ? { solutionTypeId: b.solutionTypeId ?? null } : {}),
        ...(has('dueDate') ? { dueDate: b.dueDate ?? null } : {}),
        override: b.override ? { category: b.override.category!, note: b.override.note ?? null } : undefined,
      },
      { log: logger(c) },
    );
    return c.json(result);
  } catch (err) {
    return fail(c, err);
  }
});

const DiscardBody = z.object({ reason: z.string().max(1000).nullish() });

meetingRoutes.post('/candidates/:id/discard', async (c) => {
  const parsed = DiscardBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const candidate = await discardCandidate(meetingUser(c), idParam(c, 'la candidata'), parsed.data.reason ?? null);
    return c.json({ candidate });
  } catch (err) {
    return fail(c, err);
  }
});

// ---------------------------------------------------------------- una junta

meetingRoutes.get('/:id', async (c) => {
  try {
    return c.json(await getMeeting(idParam(c, 'la junta')));
  } catch (err) {
    return fail(c, err);
  }
});

const PatchBody = z.object({ projectId: z.string().uuid().nullable() });

meetingRoutes.patch('/:id', async (c) => {
  const parsed = PatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const meeting = await setMeetingProject(idParam(c, 'la junta'), parsed.data.projectId ?? null);
    return c.json({ meeting });
  } catch (err) {
    return fail(c, err);
  }
});

meetingRoutes.post('/:id/retry', async (c) => {
  try {
    const meeting = await retryMeeting(idParam(c, 'la junta'));
    return c.json({ meeting }, 202);
  } catch (err) {
    return fail(c, err);
  }
});

meetingRoutes.delete('/:id', async (c) => {
  try {
    await deleteMeeting(idParam(c, 'la junta'));
    return c.json({ ok: true as const });
  } catch (err) {
    return fail(c, err);
  }
});
