// Cliente HTTP de /v1/runner/*. El runner NUNCA habla con Supabase ni con Linear: solo con roz.
// fetch inyectable para los tests. Sin reintentos aquí: los decide el bucle (retry.ts).
import type {
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  RunnerNextJobResponse,
  RunnerProgressRequest,
  RunnerProgressResponse,
  RunnerPullRequest,
  RunnerPullResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
} from './types.js';

export class RozApiError extends Error {
  constructor(
    message: string,
    /** 0 = no hubo respuesta (red, timeout). */
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RozApiError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RozClientOptions {
  url: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

export class RozClient {
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RozClientOptions) {
    this.base = normalizeUrl(opts.url);
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  register(body: RunnerRegisterRequest): Promise<RunnerRegisterResponse> {
    return this.post('/v1/runner/register', body);
  }
  heartbeat(body: RunnerHeartbeatRequest): Promise<RunnerHeartbeatResponse> {
    return this.post('/v1/runner/heartbeat', body);
  }
  nextJob(): Promise<RunnerNextJobResponse> {
    return this.post('/v1/runner/next-job', {});
  }
  progress(body: RunnerProgressRequest): Promise<RunnerProgressResponse> {
    return this.post('/v1/runner/progress', body);
  }
  pull(body: RunnerPullRequest): Promise<RunnerPullResponse> {
    return this.post('/v1/runner/pull', body);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          'content-type': 'application/json',
          'user-agent': this.opts.userAgent ?? 'roz-runner',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RozApiError(`no se pudo conectar con roz (${this.base}): ${msg}`, 0, 'NETWORK', true);
    }

    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      const code = e?.code ?? `HTTP_${res.status}`;
      const retryable = res.status >= 500 || res.status === 429;
      let message = e?.message ?? `roz respondió ${res.status}`;
      if (res.status === 401) message = 'token de runner inválido o revocado: crea uno nuevo en el dashboard y corre `roz-runner login`';
      throw new RozApiError(message, res.status, code, retryable, e?.details);
    }
    if (json == null) {
      throw new RozApiError(`respuesta inesperada de roz en ${path}`, res.status, 'BAD_RESPONSE', true);
    }
    return json as T;
  }
}

/** Quita la diagonal final y valida que sea http(s). */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`URL de roz inválida: "${raw}"`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`URL de roz inválida: "${raw}" (usa https://)`);
  return trimmed;
}
