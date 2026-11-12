// Juntas desde Granola por API (opcional: sin GRANOLA_API_KEY todo es no-op).
//
//   pollGranola        ← cron /v1/internal/granola-poll (cada 5 min). Lista las notas recientes y
//                        emite `granola.import` por nota (idempotency key `granola:<noteId>`).
//   importGranolaNote  ← outbox `granola.import`. Baja la nota completa, crea la junta
//                        (source 'granola', transcript_format 'granola_api') y emite `meeting.extract`.
//
// Idempotente por id externo, en tres capas: la llave del evento, el índice único parcial
// uq_roz_meeting_external (source, external_id) y la llave de `meeting.extract` por junta.
//
// Sin cursor guardado: cada tick pide las notas creadas desde la junta de Granola más reciente que
// ya tenemos menos POLL_OVERLAP_MS (o los últimos POLL_FIRST_DAYS días la primera vez). Volver a ver
// una nota es gratis (las llaves la descartan) y así no hay estado que se pueda desincronizar.
import { getNote, granolaEnabled, listNotes } from '../adapters/granola.js';
import { db } from '../db/supabase.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import type { GranolaImportPayload } from '../types/roz-v2.js';
import { emitGranolaImport, emitMeetingExtract } from './events.js';
import { resolveProjectForEmails } from './service.js';
import { MEETING_COLUMNS, type MeetingRow } from './store.js';
import { granolaNoteText } from './transcript.js';

type Log = (msg: string, data: Record<string, unknown>) => void;

export const POLL_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;
export const POLL_FIRST_DAYS = 7;
/** Tope de páginas por tick: el cron corre cada 5 min, lo que no alcance entra en el siguiente. */
const MAX_PAGES = 5;

export type PollResult =
  | { ok: true; skipped: 'flag' | 'granola' }
  | { ok: true; listed: number; emitted: number; since: string };

/** Desde cuándo pedir notas (ISO). Pura, para probarla. */
export function pollSince(latestHeldAt: string | null, now = Date.now()): string {
  const latest = latestHeldAt ? Date.parse(latestHeldAt) : NaN;
  const since = Number.isNaN(latest) ? now - POLL_FIRST_DAYS * 24 * 60 * 60 * 1000 : latest - POLL_OVERLAP_MS;
  return new Date(since).toISOString();
}

export async function pollGranola(opts: { log?: Log } = {}): Promise<PollResult> {
  // Las juntas ya no dependen de ROZ_LINEAR_SOT: basta con tener la llave de Granola.
  if (!granolaEnabled()) return { ok: true, skipped: 'granola' };
  const log: Log = opts.log ?? (() => {});

  const { data: latest, error } = await db()
    .from('meeting')
    .select('held_at')
    .eq('source', 'granola')
    .order('held_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const since = pollSince((latest as { held_at: string } | null)?.held_at ?? null);

  let cursor: string | null = null;
  let listed = 0;
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await listNotes({ createdAfter: since, cursor });
    listed += r.notes.length;
    ids.push(...r.notes.map((n) => n.id));
    if (!r.hasMore) break;
    cursor = r.cursor;
  }

  // Las que ya son junta no se vuelven a emitir (la llave del evento las descartaría igual).
  const known = new Set<string>();
  if (ids.length) {
    const { data: rows, error: kErr } = await db().from('meeting').select('external_id').eq('source', 'granola').in('external_id', ids);
    if (kErr) throw kErr;
    for (const r of (rows ?? []) as { external_id: string }[]) known.add(r.external_id);
  }
  let emitted = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    if (await emitGranolaImport({ noteId: id })) emitted++;
  }
  log('granola: sondeo', { since, listed, emitted });
  return { ok: true, listed, emitted, since };
}

export async function importGranolaNote(p: GranolaImportPayload, opts: { log?: Log } = {}): Promise<{ meetingId: string | null; created: boolean }> {
  const log: Log = opts.log ?? (() => {});
  const noteId = String(p.noteId ?? '');
  if (!noteId || !granolaEnabled()) return { meetingId: null, created: false };

  const existing = await findByNote(noteId);
  if (existing) {
    // Ya importada: asegurar que su extracción esté encolada (la llave la hace no-op si ya lo estaba).
    await emitMeetingExtract({ meetingId: existing.id }, `meeting-extract:${existing.id}:0`);
    return { meetingId: existing.id, created: false };
  }

  const note = await getNote(noteId);
  if (!note) {
    log('granola: la nota ya no existe', { noteId });
    return { meetingId: null, created: false };
  }
  const transcript = granolaNoteText(note);
  if (!transcript) {
    // La junta acaba de terminar y Granola todavía no tiene texto: el outbox reintenta con backoff.
    throw new Error(`granola: la nota ${noteId} todavía no tiene resumen ni transcripción`);
  }

  const heldAt = note.startAt ?? note.createdAt ?? new Date().toISOString();
  const durationMin =
    note.startAt && note.endAt ? Math.round((Date.parse(note.endAt) - Date.parse(note.startAt)) / 60000) : null;
  const emails = note.attendees.map((a) => a.email).filter((e): e is string => !!e);
  const resolved = emails.length ? await resolveProjectForEmails(emails) : { projectId: null, matches: [] };

  const { data, error } = await db()
    .from('meeting')
    .insert({
      source: 'granola',
      external_id: noteId,
      title: (note.title?.trim() || 'Junta sin título').slice(0, 200),
      held_at: new Date(heldAt).toISOString(),
      duration_min: durationMin && durationMin >= 1 && durationMin <= 1440 ? durationMin : null,
      attendees: note.attendees.slice(0, 100),
      project_id: resolved.projectId,
      project_source: resolved.projectId ? 'dominio' : null,
      transcript_format: 'granola_api',
      transcript,
      status: 'pendiente',
    })
    .select(MEETING_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const again = await findByNote(noteId);
      return { meetingId: again?.id ?? null, created: false };
    }
    throw error;
  }
  const row = data as unknown as MeetingRow;
  await emitMeetingExtract({ meetingId: row.id }, `meeting-extract:${row.id}:0`);
  log('granola: junta importada', { noteId, meetingId: row.id, projectId: resolved.projectId });
  return { meetingId: row.id, created: true };
}

async function findByNote(noteId: string): Promise<{ id: string } | null> {
  const { data, error } = await db().from('meeting').select('id').eq('source', 'granola').eq('external_id', noteId).maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null) ?? null;
}
