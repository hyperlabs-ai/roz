// Extracción con Claude: del texto de una junta salen tareas, compromisos y decisiones, CADA UNA con
// la cita literal que la respalda. Claude propone; el código verifica (quotes.ts) y descarta lo que
// no esté en el texto.
//
// La salida es JSON validado con zod. Si no parsea o no valida, se reintenta UNA vez diciéndole a
// Claude qué falló; si vuelve a fallar → ExtractionError (no reintentable): la junta queda en
// 'error' con "revisar: …" para que una persona la vea (reintentar no arregla una respuesta mal
// formada dos veces seguidas). Un error de RED/API de Claude sí se relanza tal cual: el outbox lo
// reintenta con backoff.
import { z } from 'zod';
import { complete as claudeComplete, type CompleteInput } from '../adapters/anthropic.js';
import type { MeetingAttendee } from '../types/roz-v2.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullish(),
  quote: z.string().trim().min(1).max(2000),
  /** Quién quedó a cargo según el texto (nombre o correo). */
  owner: z.string().max(200).nullish(),
  /** Cuándo, como se dijo ("el viernes", "antes del lanzamiento"). */
  due: z.string().max(200).nullish(),
  /** La misma fecha resuelta (YYYY-MM-DD) si el texto la deja clara; si no, null. */
  dueDate: z.string().nullish(),
});

const DecisionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullish(),
  quote: z.string().trim().min(1).max(2000),
});

export const ExtractionSchema = z.object({
  tareas: z.array(ItemSchema).max(60).default([]),
  compromisos: z.array(ItemSchema).max(60).default([]),
  decisiones: z.array(DecisionSchema).max(60).default([]),
});

export interface ExtractedItem {
  title: string;
  description: string | null;
  quote: string;
  owner: string | null;
  due: string | null;
  dueDate: string | null;
}
export interface ExtractedDecision {
  title: string;
  description: string | null;
  quote: string;
}
export interface Extraction {
  tareas: ExtractedItem[];
  compromisos: ExtractedItem[];
  decisiones: ExtractedDecision[];
}

export class ExtractionError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/** El primer objeto JSON del texto (Claude a veces lo envuelve en ```json … ```). */
export function extractJsonObject(s: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const src = fenced ? fenced[1]! : s;
  const a = src.indexOf('{');
  const b = src.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(src.slice(a, b + 1));
  } catch {
    return null;
  }
}

function validDate(d: string | null | undefined): string | null {
  if (!d || !DATE_RE.test(d)) return null;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) ? null : d;
}

function item(i: z.infer<typeof ItemSchema>): ExtractedItem {
  return {
    title: i.title!,
    description: i.description?.trim() || null,
    quote: i.quote!,
    owner: i.owner?.trim() || null,
    due: i.due?.trim() || null,
    dueDate: validDate(i.dueDate),
  };
}

/** Valida la respuesta de Claude. Devuelve el resultado o el motivo del rechazo (para el reintento). */
export function parseExtraction(text: string): { ok: true; value: Extraction } | { ok: false; error: string } {
  const json = extractJsonObject(text);
  if (json === null) return { ok: false, error: 'la respuesta no trae un objeto JSON válido' };
  const parsed = ExtractionSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`);
    return { ok: false, error: `el JSON no cumple el formato (${issues.join('; ')})` };
  }
  const { tareas, compromisos, decisiones } = parsed.data;
  return {
    ok: true,
    value: {
      tareas: (tareas ?? []).map(item),
      compromisos: (compromisos ?? []).map(item),
      decisiones: (decisiones ?? []).map((d) => ({ title: d.title!, description: d.description?.trim() || null, quote: d.quote! })),
    },
  };
}

const SYSTEM = `Eres el secretario técnico de un equipo de desarrollo de software. Lees la transcripción o las notas de una junta y extraes SOLO lo accionable:

- "tareas": trabajo concreto que alguien del equipo tiene que hacer (construir, arreglar, investigar, configurar, entregar).
- "compromisos": algo que una persona dijo que haría con fecha o plazo ("te lo mando el viernes", "lo reviso mañana"), aunque no sea código.
- "decisiones": acuerdos que fijan el rumbo ("vamos con Stripe", "el lanzamiento se mueve a marzo"). No son trabajo, son conocimiento.

Reglas:
1. CADA elemento lleva "quote": una cita LITERAL, copiada carácter por carácter de la transcripción (una o dos frases contiguas, de 8 a 40 palabras). NO la parafrasees, NO la resumas, NO corrijas su ortografía, NO juntes frases separadas. Si no puedes citar literalmente, NO incluyas el elemento.
2. No inventes trabajo que no se dijo. Opiniones, ideas sin acuerdo y temas solo mencionados NO son tareas.
3. "title": imperativo, corto y específico (máx. 12 palabras), p.ej. "Agregar exportación a CSV en reportes".
4. "description": 1-4 frases con el contexto necesario para hacerlo sin haber estado en la junta (qué, por qué, criterio de terminado si se dijo). null si no hay más que el título.
5. "owner": nombre o correo de quien quedó a cargo SEGÚN EL TEXTO; null si nadie.
6. "due": el plazo como se dijo; "dueDate": esa fecha en YYYY-MM-DD solo si es inequívoca tomando como referencia la fecha de la junta; si no, null.
7. No repitas: si la misma tarea se menciona varias veces, una sola entrada (la cita más clara).

Responde SOLO con un objeto JSON, sin texto alrededor:
{"tareas":[{"title":"…","description":"…","quote":"…","owner":null,"due":null,"dueDate":null}],"compromisos":[…mismo formato…],"decisiones":[{"title":"…","description":"…","quote":"…"}]}
Las claves del JSON van exactamente así (en español, minúsculas). Listas vacías si no hay nada.`;

export interface ExtractInput {
  title: string;
  heldAt: string;
  attendees: MeetingAttendee[];
  projectName: string | null;
  transcript: string;
}

function userPrompt(m: ExtractInput): string {
  const who = m.attendees.length
    ? m.attendees.map((a) => (a.email ? `${a.name} <${a.email}>` : a.name)).join(', ')
    : '(no se registraron)';
  return [
    `Junta: ${m.title}`,
    `Fecha: ${m.heldAt.slice(0, 10)}`,
    `Proyecto: ${m.projectName ?? '(sin proyecto)'}`,
    `Asistentes: ${who}`,
    '',
    '<transcripcion>',
    m.transcript,
    '</transcripcion>',
  ].join('\n');
}

export type CompleteFn = (input: CompleteInput) => Promise<string>;

/**
 * Pide la extracción a Claude. Un intento + UN reintento si la respuesta no valida. `completeFn` se
 * inyecta en tests (nunca se llama a la API real ahí).
 */
export async function extractFromTranscript(
  m: ExtractInput,
  completeFn: CompleteFn = claudeComplete,
): Promise<{ extraction: Extraction; attempts: number }> {
  const base: CompleteInput = { system: SYSTEM, user: userPrompt(m), maxTokens: 8000 };
  const first = parseExtraction(await completeFn(base));
  if (first.ok) return { extraction: first.value, attempts: 1 };

  const retry: CompleteInput = {
    ...base,
    user: `${base.user}\n\nTu respuesta anterior no se pudo usar: ${'error' in first ? first.error : ''}. Responde de nuevo SOLO con el objeto JSON del formato pedido.`,
  };
  const second = parseExtraction(await completeFn(retry));
  if (second.ok) return { extraction: second.value, attempts: 2 };
  throw new ExtractionError(`revisar: Claude no devolvió una extracción válida dos veces (${'error' in second ? second.error : ''})`);
}
