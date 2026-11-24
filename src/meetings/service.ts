// Juntas: lo que llaman las rutas del dashboard (src/routes/meetings.ts), el /roz junta de Discord y
// el MCP de zeus (src/zeus/mcp-meetings.ts). Las juntas son solo REGISTRO: se guardan el texto, quién
// estuvo, cuándo y de qué proyecto, y se recuperan buscando. Ya no se extraen tareas con IA (el
// extractor de pipeline.ts quedó sin uso).
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import type { ManualTranscriptFormat, MeetingAttendee, MeetingDetail, MeetingSummary, ParsedMeetingPaste } from '../types/roz-v2.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { emailDomain, resolveProjectByDomains, type DomainResolution } from './domains.js';
import { parseMeetingPaste, pastedHeldAt, fold } from './paste.js';
import { relinkMeetingAtoms } from './pipeline.js';
import { MEETING_COLUMNS, accentRegex, loadMeeting, searchTerms, snippetOf, toDetail, toSummaries, toSummary, type MeetingRow } from './store.js';
import { normalizeTranscript } from './transcript.js';

type Log = (msg: string, data: Record<string, unknown>) => void;

/** Quién hace la acción (sale de la sesión, nunca del body). */
export interface MeetingUser {
  /** auth.users.id */
  id: string;
  devId: string;
  devName: string;
}

// ---- Contrato HTTP (espejo en web/src/lib/api.ts)

export interface CreateMeetingRequest {
  /** Sin título (o vacío) se toma el que se lee del texto; si tampoco hay, "Junta sin título". */
  title?: string | null;
  /** Sin fecha se toma la que se lee del texto; si tampoco hay, ahora. */
  heldAt?: string | null;
  durationMin?: number | null;
  /** Vacío = los que se leen del texto. */
  attendees?: MeetingAttendee[];
  projectId?: string | null;
  format?: ManualTranscriptFormat;
  content: string;
  fileName?: string | null;
}

export interface UpdateMeetingRequest {
  title?: string;
  heldAt?: string;
  durationMin?: number | null;
  attendees?: MeetingAttendee[];
  projectId?: string | null;
}

export interface ListMeetingsOptions {
  /** Texto libre: cada palabra debe aparecer en el título o en el transcript. */
  q?: string | null;
  projectId?: string | null;
  /** Nombre o correo (parcial) de alguien que estuvo. */
  attendee?: string | null;
  /** ISO o 'YYYY-MM-DD' (día completo, hora del equipo). */
  from?: string | null;
  to?: string | null;
  limit?: number;
}

// ---------------------------------------------------------------- piezas

/** Asistentes limpios: correo en minúsculas, nombre o (si falta) la parte local del correo. */
export function cleanAttendees(list: MeetingAttendee[]): MeetingAttendee[] {
  const out: MeetingAttendee[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const email = a.email?.trim().toLowerCase() || null;
    const name = a.name?.trim() || email?.split('@')[0] || '';
    if (!name) continue;
    const key = email ?? `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name.slice(0, 200), email: email && emailDomain(email) ? email : null });
  }
  return out.slice(0, 100);
}

async function assertProject(projectId: string): Promise<void> {
  const { data, error } = await db().from('project').select('id').eq('id', projectId).maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError('el proyecto no existe');
}

/** Dominios del equipo (los de los devs y los permitidos del dashboard): no dicen de qué cliente es la junta. */
async function teamDomains(): Promise<string[]> {
  const { data, error } = await db().from('dev').select('email, github_email');
  if (error) throw error;
  const domains = new Set<string>(config.dashboard.allowedDomains);
  for (const d of (data ?? []) as { email: string | null; github_email: string | null }[]) {
    for (const e of [d.email, d.github_email]) {
      const dom = emailDomain(e);
      if (dom && !dom.endsWith('users.noreply.github.com')) domains.add(dom);
    }
  }
  return [...domains];
}

/** Proyecto por dominio del correo de los asistentes (project.client_email_domains). */
export async function resolveProjectForEmails(emails: string[]): Promise<DomainResolution> {
  const { data, error } = await db().from('project').select('id, name, active, client_email_domains');
  if (error) throw error;
  const projects = ((data ?? []) as { id: string; name: string; active: boolean | null; client_email_domains: string[] | null }[])
    .filter((p) => p.active !== false && (p.client_email_domains ?? []).length > 0)
    .map((p) => ({ id: p.id, name: p.name, domains: p.client_email_domains ?? [] }));
  if (!projects.length) return { projectId: null, matches: [] };
  return resolveProjectByDomains(emails, projects, await teamDomains());
}

/** Lo que se autollena al pegar (sin guardar nada). */
export function parsePaste(content: string): ParsedMeetingPaste {
  return parseMeetingPaste(content);
}

function validDuration(n: number | null | undefined): number | null {
  return n != null && Number.isInteger(n) && n >= 1 && n <= 1440 ? n : null;
}

// ---------------------------------------------------------------- juntas

export async function createMeeting(user: MeetingUser, req: CreateMeetingRequest, opts: { log?: Log } = {}): Promise<MeetingSummary> {
  const transcript = normalizeTranscript(req.format ?? 'texto', req.content, req.fileName ?? null);
  const parsed = parseMeetingPaste(req.content);

  const title = (req.title?.trim() || parsed.title || 'Junta sin título').slice(0, 200);
  const heldAt = new Date(req.heldAt || pastedHeldAt(parsed) || Date.now());
  if (Number.isNaN(heldAt.getTime())) throw new ValidationError('fecha de la junta inválida');
  const attendees = cleanAttendees(req.attendees?.length ? req.attendees : parsed.attendees);
  const durationMin = validDuration(req.durationMin) ?? (req.durationMin === undefined ? validDuration(parsed.durationMin) : null);

  let projectId: string | null = null;
  let projectSource: 'dominio' | 'elegido' | null = null;
  if (req.projectId) {
    await assertProject(req.projectId);
    projectId = req.projectId;
    projectSource = 'elegido';
  } else {
    const r = await resolveProjectForEmails(attendees.map((a) => a.email).filter((e): e is string => !!e));
    if (r.projectId) {
      projectId = r.projectId;
      projectSource = 'dominio';
    }
  }

  const { data, error } = await db()
    .from('meeting')
    .insert({
      source: 'manual',
      title,
      held_at: heldAt.toISOString(),
      duration_min: durationMin,
      attendees,
      project_id: projectId,
      project_source: projectSource,
      transcript_format: req.format ?? 'texto',
      transcript,
      // Sin extracción: la junta queda lista al guardarse.
      status: 'lista',
      created_by: user.id,
      created_by_dev_id: user.devId,
    })
    .select(MEETING_COLUMNS)
    .single();
  if (error) throw error;
  const row = data as unknown as MeetingRow;
  opts.log?.('juntas: creada', { meetingId: row.id, projectId, projectSource, chars: transcript.length });
  return toSummary(row);
}

/** 'YYYY-MM-DD' → inicio o fin de ese día en la hora del equipo (UTC-6); un ISO completo pasa tal cual. */
function dayBound(s: string, end: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T${end ? '23:59:59.999' : '00:00:00'}-06:00`).toISOString();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`fecha inválida: ${s}`);
  return d.toISOString();
}

/**
 * Lista o busca juntas, la más reciente primero. Con `q`, cada palabra (sin importar acentos ni
 * mayúsculas) debe aparecer en el título o en el transcript, y cada resultado trae un
 * recorte del texto donde coincidió.
 *
 * Sin índice de texto a propósito: para unos cientos de juntas, una regex por fila responde en
 * milisegundos. Si pasan de miles, el siguiente paso es pg_trgm sobre transcript.
 */
export async function listMeetings(opts: ListMeetingsOptions = {}): Promise<MeetingSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const terms = searchTerms(opts.q);
  const who = opts.attendee?.trim() ? fold(opts.attendee.trim()) : null;

  let q = db().from('meeting').select(MEETING_COLUMNS).order('held_at', { ascending: false });
  if (opts.projectId) q = q.eq('project_id', opts.projectId);
  if (opts.from) q = q.gte('held_at', dayBound(opts.from, false));
  if (opts.to) q = q.lte('held_at', dayBound(opts.to, true));
  for (const t of terms) {
    const re = accentRegex(t);
    // Entre comillas: los corchetes de la regex no se confunden con la sintaxis del filtro.
    q = q.or(`title.imatch."${re}",transcript.imatch."${re}"`);
  }
  // El filtro por asistente se aplica aquí (attendees es jsonb): se piden más filas para no quedarse corto.
  q = q.limit(who ? 500 : limit);
  const { data, error } = await q;
  if (error) throw error;

  let rows = (data ?? []) as unknown as MeetingRow[];
  if (who) {
    rows = rows.filter((m) => (m.attendees ?? []).some((a) => fold(`${a.name ?? ''} ${a.email ?? ''}`).includes(who)));
  }
  rows = rows.slice(0, limit);
  const summaries = await toSummaries(rows);
  if (!terms.length || !rows.length) return summaries;

  // El recorte necesita el texto: se trae solo el de la página que se devuelve.
  const { data: texts, error: tErr } = await db()
    .from('meeting')
    .select('id, transcript')
    .in('id', rows.map((r) => r.id));
  if (tErr) throw tErr;
  const byId = new Map(((texts ?? []) as { id: string; transcript: string }[]).map((t) => [t.id, t.transcript]));
  return summaries.map((s) => ({ ...s, snippet: snippetOf(byId.get(s.id) ?? '', terms) }));
}

export async function getMeeting(id: string): Promise<MeetingDetail> {
  const row = await loadMeeting(id, true);
  if (!row) throw new NotFoundError('la junta no existe');
  return toDetail(row);
}

export async function updateMeeting(id: string, patch: UpdateMeetingRequest): Promise<MeetingSummary> {
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new ValidationError('la junta necesita un título');
    set.title = title.slice(0, 200);
  }
  if (patch.heldAt !== undefined) {
    const d = new Date(patch.heldAt);
    if (Number.isNaN(d.getTime())) throw new ValidationError('fecha de la junta inválida');
    set.held_at = d.toISOString();
  }
  if (patch.durationMin !== undefined) set.duration_min = validDuration(patch.durationMin);
  if (patch.attendees !== undefined) set.attendees = cleanAttendees(patch.attendees);
  if (patch.projectId !== undefined) {
    if (patch.projectId) await assertProject(patch.projectId);
    set.project_id = patch.projectId;
    set.project_source = patch.projectId ? 'elegido' : null;
  }
  const { data, error } = await db().from('meeting').update(set).eq('id', id).select(MEETING_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('la junta no existe');
  // Las decisiones que el extractor guardó en el brain (juntas viejas) siguen al proyecto de su junta.
  if (patch.projectId !== undefined) await relinkMeetingAtoms(id, patch.projectId);
  return toSummary(data as unknown as MeetingRow);
}

/** Compatibilidad: solo cambia el proyecto. */
export function setMeetingProject(id: string, projectId: string | null): Promise<MeetingSummary> {
  return updateMeeting(id, { projectId });
}

export async function deleteMeeting(id: string): Promise<void> {
  const { data, error } = await db().from('meeting').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!(data ?? []).length) throw new NotFoundError('la junta no existe');
}
