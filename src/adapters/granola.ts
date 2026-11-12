// Granola (roz v2): lectura de notas de juntas por la API pública. SOLO LECTURA: roz nunca escribe en
// Granola. Sin GRANOLA_API_KEY todo queda apagado (granolaEnabled() = false) y las juntas entran a
// mano (pegar texto, subir .txt/.vtt/.srt o el resumen copiado de Granola).
//
// Aquí solo vive el TRANSPORTE (mismo patrón que src/adapters/linear.ts y typesafe.ts): `fetch`
// directo, sin reintentos (los decide el outbox), y un error de la API es un ERROR, nunca una lista
// vacía — "Granola no contestó" no es "no hubo juntas".
//
// Forma de la API (fijada aquí; si Granola la cambia, cambia SOLO este archivo):
//   GET {base}/v1/notes?created_after=<ISO>&cursor=<c>&page_size=<n>
//       → { notes: [{ id, title, created_at, updated_at }], hasMore, cursor }
//   GET {base}/v1/notes/{id}?include=transcript
//       → { id, title, created_at, attendees[{ name, email }], calendar_event{ scheduled_start_time,
//           scheduled_end_time, invitees[{ email }] }, summary_markdown | summary_text,
//           transcript[{ speaker{ source, diarization_label? } | string, text, start_time }] }
//   Auth: `Authorization: Bearer <GRANOLA_API_KEY>`.
// El parseo es TOLERANTE (todo opcional): un campo que falta no tumba la importación; lo único
// obligatorio es el `id` de la nota.
import { z } from 'zod';
import { config } from '../config.js';

// ---------------------------------------------------------------- tipos

export interface GranolaNoteSummary {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GranolaTranscriptEntry {
  /** Quién habló, si Granola lo sabe ("Ana", "Tú", "Otro participante"). */
  speaker: string | null;
  text: string;
  startTime: string | null;
}

export interface GranolaNote {
  id: string;
  title: string | null;
  createdAt: string | null;
  /** Inicio/fin según el evento de calendario (si la nota tenía uno). */
  startAt: string | null;
  endAt: string | null;
  attendees: { name: string; email: string | null }[];
  summaryMarkdown: string | null;
  transcript: GranolaTranscriptEntry[];
}

export interface GranolaNotesPage {
  notes: GranolaNoteSummary[];
  cursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------- errores

export class GranolaError extends Error {
  /** HTTP status; null = no hubo respuesta (red, timeout) o no se pudo leer. */
  readonly status: number | null;
  /** true = vale la pena reintentar más tarde (429, 5xx, red). */
  readonly retryable: boolean;
  readonly code: string | null;
  readonly detail: unknown;

  constructor(message: string, opts: { status: number | null; retryable: boolean; code?: string | null; detail?: unknown }) {
    super(message);
    this.name = 'GranolaError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.code = opts.code ?? null;
    this.detail = opts.detail ?? null;
  }
}

const TIMEOUT_MS = 20_000;

/** Sin llave = apagado: ni el poll ni la importación llaman a la red. */
export function granolaEnabled(): boolean {
  return config.granola.apiKey !== '';
}

async function granolaGet(path: string, query: Record<string, string | undefined> = {}): Promise<{ status: number; body: unknown }> {
  if (!granolaEnabled()) {
    throw new GranolaError('GRANOLA_API_KEY no configurado', { status: null, retryable: false, code: 'not_configured' });
  }
  const url = new URL(`${config.granola.baseUrl}${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${config.granola.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new GranolaError(timeout ? `Granola no respondió en ${TIMEOUT_MS / 1000}s` : `Granola inalcanzable: ${String(err)}`, {
      status: null,
      retryable: true,
      code: timeout ? 'timeout' : 'network',
    });
  }

  const text = await res.text().catch(() => '');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (res.status === 404) return { status: 404, body };
  if (res.status === 429) {
    throw new GranolaError('Granola: límite de solicitudes', { status: 429, retryable: true, code: 'rate_limited', detail: body ?? text });
  }
  if (!res.ok) {
    throw new GranolaError(`Granola ${res.status}`, {
      status: res.status,
      retryable: res.status >= 500,
      code: res.status === 401 || res.status === 403 ? 'unauthorized' : null,
      detail: body ?? text,
    });
  }
  if (body === undefined) {
    throw new GranolaError('respuesta_invalida de Granola', { status: res.status, retryable: false, code: 'respuesta_invalida', detail: text });
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------- parseo tolerante

const str = z.string().nullish();
const Person = z.object({ name: str, email: str }).passthrough();

const NoteSummaryWire = z
  .object({ id: z.string().min(1), title: str, created_at: str, updated_at: str })
  .passthrough();

const NotesPageWire = z
  .object({
    notes: z.array(NoteSummaryWire).default([]),
    hasMore: z.boolean().nullish(),
    has_more: z.boolean().nullish(),
    cursor: str,
    next_cursor: str,
  })
  .passthrough();

const TranscriptWire = z
  .object({
    speaker: z.union([z.string(), z.object({ source: str, diarization_label: str, name: str }).passthrough()]).nullish(),
    text: z.string().default(''),
    start_time: str,
  })
  .passthrough();

const NoteWire = z
  .object({
    id: z.string().min(1),
    title: str,
    created_at: str,
    attendees: z.array(Person).nullish(),
    calendar_event: z
      .object({
        event_title: str,
        scheduled_start_time: str,
        scheduled_end_time: str,
        invitees: z.array(Person).nullish(),
      })
      .passthrough()
      .nullish(),
    summary_markdown: str,
    summary_text: str,
    transcript: z.array(TranscriptWire).nullish(),
  })
  .passthrough();

function speakerName(s: z.infer<typeof TranscriptWire>['speaker']): string | null {
  if (!s) return null;
  if (typeof s === 'string') return s.trim() || null;
  const label = s.name ?? s.diarization_label ?? null;
  if (label && label.trim()) return label.trim();
  // `source`: microphone = quien grabó; speaker = los demás (Granola no siempre los distingue).
  if (s.source === 'microphone') return 'Yo';
  if (s.source === 'speaker') return 'Participante';
  return null;
}

/** Asistentes: los de la nota y los invitados del calendario, sin repetir correo. */
export function noteAttendees(n: z.infer<typeof NoteWire>): { name: string; email: string | null }[] {
  const out: { name: string; email: string | null }[] = [];
  const seen = new Set<string>();
  for (const p of [...(n.attendees ?? []), ...(n.calendar_event?.invitees ?? [])]) {
    const email = p.email?.trim().toLowerCase() || null;
    const name = p.name?.trim() || email?.split('@')[0] || '';
    if (!name && !email) continue;
    const key = email ?? `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || email!, email });
  }
  return out;
}

function invalid(detail: unknown): never {
  throw new GranolaError('respuesta_invalida de Granola', { status: 200, retryable: false, code: 'respuesta_invalida', detail });
}

// ---------------------------------------------------------------- llamadas

/** Una página de notas creadas después de `createdAfter` (ISO). */
export async function listNotes(opts: { createdAfter?: string | null; cursor?: string | null; pageSize?: number } = {}): Promise<GranolaNotesPage> {
  const { body } = await granolaGet('/v1/notes', {
    created_after: opts.createdAfter ?? undefined,
    cursor: opts.cursor ?? undefined,
    page_size: String(opts.pageSize ?? 30),
  });
  const parsed = NotesPageWire.safeParse(body);
  if (!parsed.success) invalid(parsed.error.issues);
  const p = parsed.data;
  const cursor = p.cursor ?? p.next_cursor ?? null;
  return {
    notes: p.notes.map((n) => ({ id: n.id!, title: n.title ?? null, createdAt: n.created_at ?? null, updatedAt: n.updated_at ?? null })),
    cursor,
    hasMore: (p.hasMore ?? p.has_more ?? false) && !!cursor,
  };
}

/** La nota completa con su transcripción. null = ya no existe (404). */
export async function getNote(id: string): Promise<GranolaNote | null> {
  const { status, body } = await granolaGet(`/v1/notes/${encodeURIComponent(id)}`, { include: 'transcript' });
  if (status === 404) return null;
  const parsed = NoteWire.safeParse(body);
  if (!parsed.success) invalid(parsed.error.issues);
  const n = parsed.data;
  return {
    id: n.id!,
    title: n.title ?? n.calendar_event?.event_title ?? null,
    createdAt: n.created_at ?? null,
    startAt: n.calendar_event?.scheduled_start_time ?? null,
    endAt: n.calendar_event?.scheduled_end_time ?? null,
    attendees: noteAttendees(n),
    summaryMarkdown: (n.summary_markdown ?? n.summary_text ?? '').trim() || null,
    transcript: (n.transcript ?? [])
      .map((t) => ({ speaker: speakerName(t.speaker), text: (t.text ?? '').trim(), startTime: t.start_time ?? null }))
      .filter((t) => t.text !== ''),
  };
}
