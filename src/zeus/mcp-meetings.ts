// Herramientas MCP de zeus para JUNTAS: que Claude recupere lo que se habló en una junta (buscar por
// texto, proyecto, persona o fechas, y leer el transcript completo). Solo lectura: subir una junta es
// manual (roz → Juntas o /roz junta en Discord).
//
// Quién las ve: la misma regla que el dashboard (src/routes/meetings.ts): cualquiera del equipo con
// acceso. El actor de zeus ya es un dev activo, así que no hay filtro extra por proyecto.
import { z } from 'zod';
import { getMeeting, listMeetings } from '../meetings/service.js';
import { actorActivity, logActivity, resolveProject } from './core.js';
import type { ZeusMcpTool } from './mcp.js';

/** Tope por defecto del transcript que devuelve zeus_meeting (igual que zeus_get). */
const DEFAULT_MEETING_CHARS = 24_000;

const DAY_OR_ISO = z
  .string()
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isNaN(Date.parse(s)), 'fecha inválida (usa YYYY-MM-DD)');

export const meetingTools: ZeusMcpTool[] = [
  {
    name: 'zeus_meetings',
    description:
      'Busca juntas del equipo (transcripts pegados de Granola u otras notas). Úsala cuando la persona quiera recuperar algo ' +
      'que "se habló en una junta": filtra por palabras del transcript o del título, proyecto, asistente o fechas. Devuelve ' +
      'id, título, fecha, asistentes, proyecto y, al buscar por texto, un recorte de dónde coincidió. Trae el texto completo ' +
      'con zeus_meeting. Usa 1-4 palabras clave (sin importar acentos), no una frase entera.',
    schema: z.object({
      query: z.string().max(200).optional().describe('Palabras clave: TODAS deben aparecer en el título o el transcript.'),
      projectKey: z.string().optional().describe('Clave del proyecto (de list_projects).'),
      attendee: z.string().max(200).optional().describe('Nombre o correo (parcial) de alguien que estuvo.'),
      from: DAY_OR_ISO.optional().describe('Desde esta fecha (YYYY-MM-DD, inclusive).'),
      to: DAY_OR_ISO.optional().describe('Hasta esta fecha (YYYY-MM-DD, inclusive).'),
      limit: z.number().int().min(1).max(50).optional().describe('Máximo de juntas (def 10).'),
    }),
    readOnly: true,
    handler: async (args, actor) => {
      const project = args.projectKey ? await resolveProject(args.projectKey) : null;
      const meetings = await listMeetings({
        q: args.query ?? null,
        projectId: project?.id ?? null,
        attendee: args.attendee ?? null,
        from: args.from ?? null,
        to: args.to ?? null,
        limit: args.limit ?? 10,
      });
      logActivity(actorActivity(actor), 'meetings', project ? `project:${project.id}` : null, {
        query: args.query ?? null,
        attendee: args.attendee ?? null,
        hits: meetings.length,
      });
      return {
        meetings: meetings.map((m) => ({
          id: m.id,
          title: m.title,
          heldAt: m.heldAt,
          durationMin: m.durationMin,
          attendees: m.attendees.map((a) => (a.email ? `${a.name} <${a.email}>` : a.name)),
          project: m.projectName,
          source: m.source,
          ...(m.snippet !== undefined ? { snippet: m.snippet } : {}),
        })),
        ...(meetings.length
          ? {}
          : { hint: 'Sin resultados. Prueba menos palabras o sinónimos, quita filtros, o amplía las fechas.' }),
      };
    },
  },
  {
    name: 'zeus_meeting',
    description:
      'Trae una junta completa por id (de zeus_meetings): título, fecha, asistentes, proyecto y el transcript. Si es larga ' +
      'viene recortada: pide más con offset.',
    schema: z.object({
      id: z.string().uuid().describe('id de la junta (de zeus_meetings).'),
      maxChars: z.number().int().min(500).max(100_000).optional().describe(`Máximo de caracteres del transcript (def ${DEFAULT_MEETING_CHARS}).`),
      offset: z.number().int().min(0).optional().describe('Desde qué carácter seguir leyendo un transcript recortado.'),
    }),
    readOnly: true,
    handler: async (args, actor) => {
      const m = await getMeeting(args.id);
      const max = args.maxChars ?? DEFAULT_MEETING_CHARS;
      const offset = Math.min(args.offset ?? 0, m.transcript.length);
      const transcript = m.transcript.slice(offset, offset + max);
      const rest = m.transcript.length - offset - transcript.length;
      logActivity(actorActivity(actor), 'meeting', `meeting:${m.id}`, { title: m.title });
      return {
        id: m.id,
        title: m.title,
        heldAt: m.heldAt,
        durationMin: m.durationMin,
        attendees: m.attendees.map((a) => (a.email ? `${a.name} <${a.email}>` : a.name)),
        project: m.projectName,
        source: m.source,
        uploadedBy: m.createdBy?.name ?? null,
        totalChars: m.transcript.length,
        transcript,
        ...(rest > 0 ? { truncated: `Faltan ${rest} caracteres. Sigue con offset ${offset + transcript.length}.` } : {}),
      };
    },
  },
];
