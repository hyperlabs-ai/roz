// Máquina de reintentos del polling. Pura (el azar y el reloj se inyectan) para poder probarla.
//
//   job        → pide otro de inmediato si hay cupo (pequeña pausa), y reinicia el backoff
//   sin job    → espera lo que diga el servidor (retryAfterMs, acotado), y reinicia el backoff
//   error red/5xx/429 → backoff exponencial con jitter (base 2 s, tope 5 min)
//   flag apagado (409 LINEAR_SOT_OFF) → espera larga fija; roz v2 aún no está encendido
//   401 (token revocado/inválido) → se detiene: no tiene caso seguir tocando la puerta
import { RozApiError } from './api.js';

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** 0..1: fracción del retraso que se puede recortar al azar (evita que todos los runners golpeen a la vez). */
  jitter: number;
  random?: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 2_000, maxMs: 5 * 60_000, factor: 2, jitter: 0.3 };

export class Backoff {
  private attempt = 0;
  constructor(private readonly opts: BackoffOptions = DEFAULT_BACKOFF) {}

  /** Retraso para el siguiente intento fallido (y avanza el contador). */
  next(): number {
    const { baseMs, maxMs, factor, jitter } = this.opts;
    const random = this.opts.random ?? Math.random;
    const raw = Math.min(maxMs, baseMs * Math.pow(factor, this.attempt));
    this.attempt++;
    const cut = raw * jitter * Math.min(1, Math.max(0, random()));
    return Math.max(0, Math.round(raw - cut));
  }

  reset(): void {
    this.attempt = 0;
  }

  get failures(): number {
    return this.attempt;
  }
}

export type ErrorClass = 'retry' | 'fatal' | 'flag_off' | 'lease_lost';

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof RozApiError) {
    if (err.status === 401) return 'fatal';
    if (err.code === 'LINEAR_SOT_OFF') return 'flag_off';
    if (err.code === 'LEASE_LOST') return 'lease_lost';
    return err.retryable ? 'retry' : 'fatal';
  }
  // Errores que no son de la API (DNS, fetch abortado por timeout…) → se reintenta.
  return 'retry';
}

export const POLL_AFTER_JOB_MS = 1_000;
export const POLL_MIN_WAIT_MS = 5_000;
export const POLL_MAX_WAIT_MS = 60 * 60_000;
export const FLAG_OFF_WAIT_MS = 5 * 60_000;

export type PollOutcome =
  | { kind: 'job' }
  | { kind: 'empty'; retryAfterMs: number }
  | { kind: 'error'; error: unknown };

export type PollDecision = { action: 'wait'; waitMs: number; reason: string } | { action: 'stop'; reason: string };

/** Decide cuánto esperar antes del siguiente next-job. Muta el backoff (reset en éxito, avanza en error). */
export function decidePoll(outcome: PollOutcome, backoff: Backoff): PollDecision {
  switch (outcome.kind) {
    case 'job':
      backoff.reset();
      return { action: 'wait', waitMs: POLL_AFTER_JOB_MS, reason: 'job' };
    case 'empty': {
      backoff.reset();
      const ms = Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs : POLL_MAX_WAIT_MS;
      return { action: 'wait', waitMs: clamp(ms, POLL_MIN_WAIT_MS, POLL_MAX_WAIT_MS), reason: 'sin trabajo' };
    }
    case 'error': {
      const cls = classifyError(outcome.error);
      if (cls === 'fatal') return { action: 'stop', reason: errorMessage(outcome.error) };
      if (cls === 'flag_off') {
        backoff.reset();
        return { action: 'wait', waitMs: FLAG_OFF_WAIT_MS, reason: 'roz v2 está apagado (ROZ_LINEAR_SOT)' };
      }
      return { action: 'wait', waitMs: backoff.next(), reason: errorMessage(outcome.error) };
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
