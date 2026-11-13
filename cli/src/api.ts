// Cliente HTTP de /v1/zeus/*. El CLI solo habla con zeus, y lo único que le manda de la bóveda es
// texto cifrado. fetch inyectable para los tests.
import type {
  CreateEnvBody,
  GrantBody,
  PutSecretsBody,
  RotateBody,
  VaultEnv,
  VaultKey,
  VaultProject,
  WhoAmI,
} from './types.js';

export class ZeusApiError extends Error {
  constructor(
    message: string,
    /** 0 = no hubo respuesta (red, timeout). */
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ZeusApiError';
  }
}

/** Lo que los comandos necesitan del servidor; los tests lo cumplen con un zeus en memoria. */
export interface ZeusApi {
  whoami(): Promise<WhoAmI>;
  listKeys(all?: boolean): Promise<{ keys: VaultKey[] }>;
  registerKey(body: { name: string; publicKey: string }): Promise<{ key: VaultKey }>;
  listProjects(): Promise<{ projects: VaultProject[] }>;
  createEnv(body: CreateEnvBody): Promise<{ envId: string; dekVersion: number }>;
  getEnv(projectKey: string, env: string, keyId: string): Promise<VaultEnv>;
  putSecrets(projectKey: string, env: string, body: PutSecretsBody): Promise<{ ok: boolean; written: number; deleted: number }>;
  grant(projectKey: string, env: string, body: GrantBody): Promise<{ ok: boolean; granted: number }>;
  revokeGrant(projectKey: string, env: string, keyId: string): Promise<{ ok: boolean }>;
  rotate(projectKey: string, env: string, body: RotateBody): Promise<{ ok: boolean; dekVersion: number }>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ZeusClientOptions {
  url: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

const BASE_PATH = '/v1/zeus';

export class ZeusClient implements ZeusApi {
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ZeusClientOptions) {
    this.base = normalizeUrl(opts.url);
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  whoami(): Promise<WhoAmI> {
    return this.request('GET', '/whoami');
  }
  listKeys(all = false): Promise<{ keys: VaultKey[] }> {
    return this.request('GET', `/vault/keys${all ? '?all=1' : ''}`);
  }
  registerKey(body: { name: string; publicKey: string }): Promise<{ key: VaultKey }> {
    return this.request('POST', '/vault/keys', body);
  }
  listProjects(): Promise<{ projects: VaultProject[] }> {
    return this.request('GET', '/vault/projects');
  }
  createEnv(body: CreateEnvBody): Promise<{ envId: string; dekVersion: number }> {
    return this.request('POST', '/vault/envs', body);
  }
  getEnv(projectKey: string, env: string, keyId: string): Promise<VaultEnv> {
    return this.request('GET', `${envPath(projectKey, env)}?keyId=${encodeURIComponent(keyId)}`);
  }
  putSecrets(projectKey: string, env: string, body: PutSecretsBody): Promise<{ ok: boolean; written: number; deleted: number }> {
    return this.request('PUT', `${envPath(projectKey, env)}/secrets`, body);
  }
  grant(projectKey: string, env: string, body: GrantBody): Promise<{ ok: boolean; granted: number }> {
    return this.request('POST', `${envPath(projectKey, env)}/grants`, body);
  }
  revokeGrant(projectKey: string, env: string, keyId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `${envPath(projectKey, env)}/grants/${encodeURIComponent(keyId)}`);
  }
  rotate(projectKey: string, env: string, body: RotateBody): Promise<{ ok: boolean; dekVersion: number }> {
    return this.request('POST', `${envPath(projectKey, env)}/rotate`, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.base + BASE_PATH + path, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: 'application/json',
          'user-agent': this.opts.userAgent ?? 'zeus-cli',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ZeusApiError(`no se pudo conectar con zeus (${this.base}): ${msg}`, 0, 'NETWORK');
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
      const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
      const code = e?.code ?? `HTTP_${res.status}`;
      let message = e?.message ?? `zeus respondió ${res.status}`;
      if (res.status === 401) {
        message = 'token de zeus inválido o revocado: crea uno nuevo en el dashboard (zeus → Acceso) y corre `zeus login`';
      }
      throw new ZeusApiError(message, res.status, code);
    }
    if (json == null || typeof json !== 'object') {
      throw new ZeusApiError(`respuesta inesperada de zeus en ${method} ${path.split('?')[0]}`, res.status, 'BAD_RESPONSE');
    }
    return json as T;
  }
}

function envPath(projectKey: string, env: string): string {
  return `/vault/envs/${encodeURIComponent(projectKey)}/${encodeURIComponent(env)}`;
}

/** Quita la diagonal final (y un /v1/zeus pegado de más) y valida que sea http(s). */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '').replace(/\/v1\/zeus$/, '');
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`URL de zeus inválida: "${raw}"`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`URL de zeus inválida: "${raw}" (usa https://)`);
  return trimmed;
}
