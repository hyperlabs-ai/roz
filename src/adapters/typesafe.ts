// TypeSafe (Jev): un "System One model" que responde preguntas TIPADAS (choice / noul / score) sobre
// un `state` que mandamos, con probabilidades calibradas. roz lo usa para clasificar tareas antes de
// asignarlas (src/assign). Aquí solo vive el transporte; qué se pregunta y qué se hace con las
// respuestas vive en src/assign.
//
// `fetch` directo y no el SDK oficial, por dos razones:
//   · Guardamos el cuerpo EXACTO que se envió (assignment_decision.jev_request) para poder repetir
//     cualquier caso. Si lo armamos nosotros, lo que se guarda es lo que viajó.
//   · Los reintentos los decide el outbox (backoff, dead-letter): aquí no se reintenta, solo se dice
//     si el error es reintentable.
//
// Un error de la API es un ERROR, nunca una respuesta: quien llama no debe leer un fallo como "no".
import { z } from 'zod';
import { config } from '../config.js';

// ---------------------------------------------------------------- request

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Nombre de la opción → cuándo aplica. El NOMBRE también lo ve el modelo: que sea descriptivo. */
  criteria: Record<string, string | null>;
}
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** Niveles en orden; la posición es el valor (empieza en 0). */
  criteria: string[];
}
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface SystemOneRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

// ---------------------------------------------------------------- response

const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number() });
const ChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.number()),
});
const ScoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number(),
  legend: z.record(z.unknown()),
  probabilities: z.record(z.number()),
});
const Answer = z.discriminatedUnion('type', [NoulAnswer, ChoiceAnswer, ScoreAnswer]);

const SystemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(Answer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export type NoulAnswer = z.infer<typeof NoulAnswer>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;
export type ScoreAnswer = z.infer<typeof ScoreAnswer>;
export type JevAnswer = z.infer<typeof Answer>;
export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

// ---------------------------------------------------------------- errores

export class TypeSafeError extends Error {
  /** HTTP status; null = no hubo respuesta (red, timeout) o la respuesta no se pudo leer. */
  readonly status: number | null;
  /** true = vale la pena reintentar más tarde (429, 5xx, red, timeout). */
  readonly retryable: boolean;
  /** Segundos que pidió la API vía `retry-after` (429), si los mandó. */
  readonly retryAfterSec: number | null;
  /** Lo que devolvió la API como explicación (400/422), para dejarlo en el log de la decisión. */
  readonly detail: unknown;

  constructor(message: string, opts: { status: number | null; retryable: boolean; retryAfterSec?: number | null; detail?: unknown }) {
    super(message);
    this.name = 'TypeSafeError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.detail = opts.detail ?? null;
  }
}

const TIMEOUT_MS = 20_000;

export function typesafeEnabled(): boolean {
  return config.typesafe.apiKey !== '';
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * Una evaluación de Jev. `req` ES el cuerpo que viaja (se serializa tal cual), así que quien llama
 * puede guardarlo como registro exacto. La llave va en el header y nunca dentro de `req`.
 */
export async function systemOne(req: SystemOneRequest): Promise<SystemOneResponse> {
  if (!typesafeEnabled()) {
    throw new TypeSafeError('TYPESAFE_API_KEY no configurado', { status: null, retryable: false });
  }

  let res: Response;
  try {
    res = await fetch(`${config.typesafe.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.typesafe.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new TypeSafeError(timeout ? `TypeSafe no respondió en ${TIMEOUT_MS / 1000}s` : `TypeSafe inalcanzable: ${String(err)}`, {
      status: null,
      retryable: true,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail: unknown = text;
    try {
      detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text;
    } catch {
      /* cuerpo no-JSON: se deja como texto */
    }
    const retryable = res.status === 429 || res.status >= 500;
    throw new TypeSafeError(`TypeSafe ${res.status}`, {
      status: res.status,
      retryable,
      retryAfterSec: res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null,
      detail,
    });
  }

  const parsed = SystemOneResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    // Una respuesta 200 con otra forma no se arregla reintentando: es un cambio de contrato.
    throw new TypeSafeError('respuesta_invalida de TypeSafe', { status: res.status, retryable: false, detail: parsed.error.message });
  }
  return parsed.data;
}
