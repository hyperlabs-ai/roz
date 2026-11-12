import { describe, expect, it } from 'vitest';
import { RozApiError } from '../src/api.js';
import {
  Backoff,
  FLAG_OFF_WAIT_MS,
  POLL_AFTER_JOB_MS,
  POLL_MAX_WAIT_MS,
  POLL_MIN_WAIT_MS,
  classifyError,
  decidePoll,
} from '../src/retry.js';

const noJitter = () => new Backoff({ baseMs: 1000, maxMs: 10_000, factor: 2, jitter: 0 });

describe('Backoff', () => {
  it('crece exponencialmente hasta el tope y se reinicia', () => {
    const b = noJitter();
    expect([b.next(), b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(b.failures).toBe(6);
    b.reset();
    expect(b.next()).toBe(1000);
  });

  it('el jitter solo recorta, nunca alarga', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 10_000, factor: 2, jitter: 0.5, random: () => 1 });
    expect(b.next()).toBe(500);
    const c = new Backoff({ baseMs: 1000, maxMs: 10_000, factor: 2, jitter: 0.5, random: () => 0 });
    expect(c.next()).toBe(1000);
  });
});

describe('classifyError', () => {
  it('clasifica por estado y código', () => {
    expect(classifyError(new RozApiError('x', 401, 'RUNNER_UNAUTHORIZED', false))).toBe('fatal');
    expect(classifyError(new RozApiError('x', 409, 'LINEAR_SOT_OFF', false))).toBe('flag_off');
    expect(classifyError(new RozApiError('x', 409, 'LEASE_LOST', false))).toBe('lease_lost');
    expect(classifyError(new RozApiError('x', 503, 'HTTP_503', true))).toBe('retry');
    expect(classifyError(new RozApiError('x', 0, 'NETWORK', true))).toBe('retry');
    expect(classifyError(new RozApiError('x', 400, 'BAD', false))).toBe('fatal');
    expect(classifyError(new Error('boom'))).toBe('retry');
  });
});

describe('decidePoll', () => {
  it('con job: pausa corta y reinicia el backoff', () => {
    const b = noJitter();
    b.next();
    b.next();
    expect(decidePoll({ kind: 'job' }, b)).toEqual({ action: 'wait', waitMs: POLL_AFTER_JOB_MS, reason: 'job' });
    expect(b.failures).toBe(0);
  });

  it('sin job: obedece retryAfterMs acotado', () => {
    const b = noJitter();
    expect(decidePoll({ kind: 'empty', retryAfterMs: 30_000 }, b)).toMatchObject({ waitMs: 30_000 });
    expect(decidePoll({ kind: 'empty', retryAfterMs: 10 }, b)).toMatchObject({ waitMs: POLL_MIN_WAIT_MS });
    expect(decidePoll({ kind: 'empty', retryAfterMs: 9e12 }, b)).toMatchObject({ waitMs: POLL_MAX_WAIT_MS });
    expect(decidePoll({ kind: 'empty', retryAfterMs: Number.POSITIVE_INFINITY }, b)).toMatchObject({ waitMs: POLL_MAX_WAIT_MS });
  });

  it('errores transitorios: backoff creciente; flag apagado: espera fija; 401: se detiene', () => {
    const b = noJitter();
    const net = new RozApiError('sin red', 0, 'NETWORK', true);
    expect(decidePoll({ kind: 'error', error: net }, b)).toMatchObject({ action: 'wait', waitMs: 1000 });
    expect(decidePoll({ kind: 'error', error: net }, b)).toMatchObject({ action: 'wait', waitMs: 2000 });
    expect(decidePoll({ kind: 'error', error: new RozApiError('off', 409, 'LINEAR_SOT_OFF', false) }, b)).toMatchObject({
      action: 'wait',
      waitMs: FLAG_OFF_WAIT_MS,
    });
    expect(b.failures).toBe(0);
    expect(decidePoll({ kind: 'error', error: new RozApiError('revocado', 401, 'RUNNER_UNAUTHORIZED', false) }, b)).toEqual({
      action: 'stop',
      reason: 'revocado',
    });
  });
});
