// API de juntas. Montada en /api/dashboard/meetings DENTRO de dashboardRoutes
// (`dashboardRoutes.route('/meetings', meetingRoutes)`), así que ya pasó por requireDashboardAuth:
// quién decide sale SIEMPRE de la sesión, nunca del body.
//
// Las juntas son solo REGISTRO (texto, asistentes, fecha, proyecto): cualquiera del equipo con sesión
// las ve y las busca; crear pide perfil de developer. La misma regla aplica en el MCP de zeus
// (src/zeus/mcp-meetings.ts).
import { Hono } from 'hono';
import { z } from 'zod';
import type { RozContext } from '../types/hono.js';
import { granolaEnabled } from '../adapters/granola.js';
import {
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  parsePaste,
  resolveProjectForEmails,
  updateMeeting,
  type MeetingUser,
} from '../meetings/service.js';
import { MEETING_TRANSCRIPT_MAX_CHARS } from '../types/roz-v2.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { fail } from './http.js';

export const meetingRoutes = new Hono<RozContext>();

const DAY_OR_ISO = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isNaN(Date.parse(s)), 'fecha inválida');

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
function idParam(c: { req: { param: (k: 'id') => string } }): string {
  const id = c.req.param('id');
  if (!UUID.safeParse(id).success) throw new NotFoundError('la junta no existe');
  return id;
}

function logger(c: any) {
  const l = c.get('logger');
  return (msg: string, data: Record<string, unknown>) => l?.info(data, msg);
}

// ---------------------------------------------------------------- lista y búsqueda

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: z.string().uuid().optional(),
  attendee: z.string().max(200).optional(),
  from: DAY_OR_ISO.optional(),
  to: DAY_OR_ISO.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

meetingRoutes.get('/', async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const { q, projectId, attendee, from, to, limit } = parsed.data;
    const meetings = await listMeetings({
      q: q ?? null,
      projectId: projectId ?? null,
      attendee: attendee ?? null,
      from: from ?? null,
      to: to ?? null,
      limit: limit ?? 50,
    });
    return c.json({ meetings, granolaEnabled: granolaEnabled() });
  } catch (err) {
    return fail(c, err);
  }
});

// ---------------------------------------------------------------- crear

const Attendee = z.object({ name: z.string().max(200), email: z.string().max(320).nullish() });
// Con holgura sobre el máximo: el límite real se aplica DESPUÉS de normalizar (marcas de tiempo fuera).
const Content = z.string().min(1).max(MEETING_TRANSCRIPT_MAX_CHARS * 3);

/** Autollenado: lo que se lee del texto pegado (título, fecha, hora, duración, asistentes). No guarda. */
meetingRoutes.post('/parse', async (c) => {
  const parsed = z.object({ content: Content }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    return c.json(parsePaste(parsed.data.content!));
  } catch (err) {
    return fail(c, err);
  }
});

const CreateBody = z.object({
  title: z.string().trim().max(200).nullish(),
  heldAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'fecha inválida').nullish(),
  durationMin: z.number().int().min(1).max(1440).nullish(),
  attendees: z.array(Attendee).max(100).optional(),
  projectId: z.string().uuid().nullish(),
  format: z.enum(['texto', 'vtt', 'srt', 'granola_resumen']).optional(),
  content: Content,
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
        title: title ?? null,
        heldAt: heldAt ?? null,
        durationMin,
        attendees: attendees?.map((a) => ({ name: a.name!, email: a.email ?? null })),
        projectId: projectId ?? null,
        format,
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

// Antes de '/:id' (si no, "resolve-project" caería como id).
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

// ---------------------------------------------------------------- una junta

meetingRoutes.get('/:id', async (c) => {
  try {
    return c.json({ meeting: await getMeeting(idParam(c)) });
  } catch (err) {
    return fail(c, err);
  }
});

const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  heldAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'fecha inválida').optional(),
  durationMin: z.number().int().min(1).max(1440).nullable().optional(),
  attendees: z.array(Attendee).max(100).optional(),
  projectId: z.string().uuid().nullable().optional(),
});

meetingRoutes.patch('/:id', async (c) => {
  const parsed = PatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error.message);
  try {
    const b = parsed.data;
    const meeting = await updateMeeting(idParam(c), {
      title: b.title,
      heldAt: b.heldAt,
      durationMin: b.durationMin,
      attendees: b.attendees?.map((a) => ({ name: a.name!, email: a.email ?? null })),
      projectId: b.projectId,
    });
    return c.json({ meeting });
  } catch (err) {
    return fail(c, err);
  }
});

meetingRoutes.delete('/:id', async (c) => {
  try {
    await deleteMeeting(idParam(c));
    return c.json({ ok: true as const });
  } catch (err) {
    return fail(c, err);
  }
});
