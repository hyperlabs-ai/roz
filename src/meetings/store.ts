// Lectura/escritura de roz.meeting y el mapeo fila (snake_case) → lo que viaja por HTTP y por el MCP
// de zeus (camelCase, tipos de src/types/roz-v2.ts). Lo relacionado (nombre del proyecto, quién la
// subió) se resuelve en LOTE con `in (…)`, sin joins embebidos de PostgREST.
import { db } from '../db/supabase.js';
import type {
  MeetingAttendee,
  MeetingDetail,
  MeetingProjectSource,
  MeetingSource,
  MeetingStatus,
  MeetingSummary,
  TranscriptFormat,
} from '../types/roz-v2.js';
import { fold } from './paste.js';

// ---------------------------------------------------------------- filas

export const MEETING_COLUMNS =
  'id, source, external_id, title, held_at, duration_min, attendees, project_id, project_source, transcript_format, status, error, extraction_model, extracted_at, created_by, created_by_dev_id, created_at, updated_at';

export interface MeetingRow {
  id: string;
  source: MeetingSource;
  external_id: string | null;
  title: string;
  held_at: string;
  duration_min: number | null;
  attendees: MeetingAttendee[] | null;
  project_id: string | null;
  project_source: MeetingProjectSource | null;
  transcript_format: TranscriptFormat;
  status: MeetingStatus;
  error: string | null;
  extraction_model: string | null;
  extracted_at: string | null;
  created_by: string | null;
  created_by_dev_id: string | null;
  created_at: string;
  updated_at: string;
  /** Solo cuando se pide (detalle / búsqueda): puede pesar cientos de KB. */
  transcript?: string;
}

function uniq(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------- lecturas sueltas

export async function loadMeeting(id: string, withTranscript = false): Promise<MeetingRow | null> {
  const { data, error } = await db()
    .from('meeting')
    .select(withTranscript ? `${MEETING_COLUMNS}, transcript` : MEETING_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as MeetingRow) ?? null;
}

export async function projectNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const list = uniq(ids);
  if (!list.length) return new Map();
  const { data, error } = await db().from('project').select('id, name').in('id', list);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
}

async function devNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const list = uniq(ids);
  if (!list.length) return new Map();
  const { data, error } = await db().from('dev').select('id, name').in('id', list);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((d) => [d.id, d.name]));
}

// ---------------------------------------------------------------- búsqueda por texto

/**
 * Palabras de una búsqueda: solo letras y números (lo demás separa), hasta 6. Así nada de lo que
 * escriba la persona llega crudo al filtro de PostgREST.
 */
export function searchTerms(q: string | null | undefined): string[] {
  return [...new Set((q ?? '').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))].slice(0, 6);
}

const ACCENTED: Record<string, string> = { a: '[aáà]', e: '[eéè]', i: '[iíì]', o: '[oóò]', u: '[uúü]', n: '[nñ]' };

/** Una palabra → regex de Postgres que ignora acentos ("reunion" encuentra "reunión"). */
export function accentRegex(term: string): string {
  let out = '';
  for (const ch of fold(term)) out += ACCENTED[ch] ?? ch;
  return out;
}

/**
 * Recorte de ~`width` caracteres alrededor de la primera palabra que aparece en el texto, en un
 * solo renglón. null si ninguna aparece (coincidió por el título).
 */
export function snippetOf(text: string, terms: string[], width = 260): string | null {
  if (!text || !terms.length) return null;
  const folded = fold(text);
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = folded.indexOf(fold(t));
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  if (at < 0) return null;
  const start = Math.max(0, at - Math.floor((width - len) / 2));
  const end = Math.min(text.length, start + width);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

// ---------------------------------------------------------------- juntas → HTTP / MCP

export async function toSummaries(rows: MeetingRow[]): Promise<MeetingSummary[]> {
  const [projects, devs] = await Promise.all([
    projectNames(rows.map((r) => r.project_id)),
    devNames(rows.map((r) => r.created_by_dev_id)),
  ]);
  return rows.map((m) => ({
    id: m.id,
    source: m.source,
    title: m.title,
    heldAt: m.held_at,
    durationMin: m.duration_min ?? null,
    attendees: Array.isArray(m.attendees) ? m.attendees : [],
    projectId: m.project_id ?? null,
    projectName: m.project_id ? projects.get(m.project_id) ?? null : null,
    createdBy: m.created_by_dev_id ? { id: m.created_by_dev_id, name: devs.get(m.created_by_dev_id) ?? 'Alguien' } : null,
    createdAt: m.created_at,
  }));
}

export async function toSummary(row: MeetingRow): Promise<MeetingSummary> {
  return (await toSummaries([row]))[0]!;
}

export async function toDetail(row: MeetingRow): Promise<MeetingDetail> {
  return { ...(await toSummary(row)), transcript: row.transcript ?? '' };
}
